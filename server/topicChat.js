// topicChat.js — the live chat under the Today tab's daily topic.
//
// One room per topic. The room id is the topic id for now; everything here
// is keyed by room id so a topic can be split into several rooms later.
// Reading and posting both need a vote on the topic, and a room only accepts
// requests while its topic is today's — at rollover the old chat is closed.
//
// Firestore (written only here, through the Admin SDK; clients cannot read
// or write any of it):
//
//   chatRooms/{roomId}/roomMessages/{id}
//     id, roomId, userId, text, stanceAtSend, replyToId, createdAt, hidden,
//     author { name, username, profileImageURL, rank, equipped… }
//       `id` starts with the send time, so ordering by it is ordering by
//       time. `author` is how the sender looked when they sent it.
//       (Not named `messages`: an existing rule lets any signed-in user read
//       every subcollection with that name.)
//   chatRooms/{roomId}/roomMutes/{userId}
//     someone muted in the room by reports, kept for review
//   socialReports/{reporterId}_{targetType}_{targetId}
//     reporterId, targetType, targetId, reason, createdAt (+ room, author
//     and text for review). The doc id makes one report per reporter+target.
//   users/{uid}/mutes/{mutedUserId}
//     userId, mutedUserId, createdAt (+ name/username for the muted list)
//
// Redis (short-lived, shared by every instance):
//   topicChat:{roomId}:online            people in the room now
//   topicChat:{roomId}:recent            latest page of messages
//   topicChat:{roomId}:cooldown:{uid}    slow mode
//   topicChat:{roomId}:last:{uid}        the user's last few messages
//   topicChat:{roomId}:muted:{uid}       muted in the room until the day ends
//   topicChat:{roomId}:reports:{uid}     who reported this author, and when
//   topicChat:{roomId}:reported:{uid}    which of their messages were reported
//   topicChat:reportCount:{uid}          reports filed by this user
//
// Socket events (all need a verified-token socket and answer via ack):
//   topicChatJoin    { roomId }                    → latest page + room state
//   topicChatLeave
//   topicChatHistory { roomId, before }            → the page before a cursor
//   topicChatSend    { roomId, text }
//   topicChatReport  { roomId, messageId, reason }
//   muteUser / unmuteUser { userId }, mutedUsers
// Server → room:
//   topicChatMessage, topicChatPresence, topicChatHidden
// Server → one user:
//   topicChatMuted

const crypto = require('crypto');
const { getAdmin, getAuth } = require('./firestoreClient');
const { client: redis } = require('./redisClient');
const { loadSocialConfig } = require('./socialConfig');
const { requireDb, publicError, unpack } = require('./socialUtil');
const dailyTopic = require('./dailyTopic');
const { checkText } = require('./contentFilter');

const ROOMS = 'chatRooms';
const MESSAGES = 'roomMessages';
const ROOM_MUTES = 'roomMutes';
const REPORTS = 'socialReports';

const DAY_MS = 24 * 60 * 60 * 1000;
const GRPC_ALREADY_EXISTS = 6;

// Someone counts as in the room for this long after their last heartbeat.
const PRESENCE_TTL_MS = 60 * 1000;
const PRESENCE_HEARTBEAT_MS = 20 * 1000;
const ONLINE_CACHE_MS = 1000;
// How long a rejected message holds the sender back, in place of the full
// slow-mode gap (they didn't post anything).
const REJECTED_COOLDOWN_MS = 1000;
// Redis keys for a room outlive it by a day, then clean themselves up.
const ROOM_KEY_TTL_S = 2 * 24 * 60 * 60;
// How a sender looked (name, avatar, rank) is reused for this long.
const AUTHOR_CACHE_MS = 5 * 60 * 1000;
const AUTHOR_CACHE_MAX = 5000;
const DUPLICATE_COMPARE_CHARS = 1000;
const MAX_REASON_LENGTH = 500;
const MAX_MUTED_LIST = 500;
const MESSAGE_ID_RE = /^\d{13}-[0-9a-f]{12}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const roomChannel = (roomId) => `topicChat:${roomId}`;
const userChannel = (uid) => `user:${uid}`;
const key = {
  online: (roomId) => `topicChat:${roomId}:online`,
  recent: (roomId) => `topicChat:${roomId}:recent`,
  cooldown: (roomId, uid) => `topicChat:${roomId}:cooldown:${uid}`,
  last: (roomId, uid) => `topicChat:${roomId}:last:${uid}`,
  muted: (roomId, uid) => `topicChat:${roomId}:muted:${uid}`,
  reports: (roomId, uid) => `topicChat:${roomId}:reports:${uid}`,
  reported: (roomId, uid) => `topicChat:${roomId}:reported:${uid}`,
  reportCount: (uid) => `topicChat:reportCount:${uid}`
};

const messagesRef = (db, roomId) => db.collection(ROOMS).doc(roomId).collection(MESSAGES);

// ── Text rules ─────────────────────────────────────────────────────────────

// What gets stored: no control or invisible characters, no trailing space,
// at most one blank line in a row.
function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const charCount = (text) => [...text].length;

// What two messages are compared by: lowercase, no accents, no punctuation.
function comparable(text) {
  const base = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const stripped = base.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  // Emoji-only and symbol-only messages have nothing left; compare them as typed.
  const out = stripped || base.replace(/\s+/g, ' ').trim();
  return [...out].slice(0, DUPLICATE_COMPARE_CHARS).join('');
}

function bigrams(text) {
  const chars = [...text];
  const map = new Map();
  for (let i = 0; i < chars.length - 1; i++) {
    const pair = chars[i] + chars[i + 1];
    map.set(pair, (map.get(pair) || 0) + 1);
  }
  return map;
}

// Sørensen–Dice on character pairs: 1 = same text, 0 = nothing in common.
function similarity(a, b) {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let sizeA = 0;
  let sizeB = 0;
  let shared = 0;
  for (const n of A.values()) sizeA += n;
  for (const [pair, n] of B) {
    sizeB += n;
    shared += Math.min(n, A.get(pair) || 0);
  }
  if (!sizeA || !sizeB) return 0;
  return (2 * shared) / (sizeA + sizeB);
}

function isRepeat(candidate, previous, threshold) {
  return previous.some((prev) => prev === candidate || similarity(candidate, prev) >= threshold);
}

// http(s)://…, www.…, or a bare domain on a common ending. Endings that
// double as ordinary words after a missing space ("agree.to", "tell.me")
// are left out on purpose.
const LINK_RE = new RegExp(
  [
    '(?:https?:\\/\\/|www\\.)\\S',
    '(?:^|[^\\p{L}\\p{N}@])(?:[a-z0-9-]+\\.)+(?:com|net|org|edu|gov|io|gg|app|xyz|info|biz|dev|link|shop|site|online|club|store)(?![\\p{L}\\p{N}])'
  ].join('|'),
  'iu'
);

const containsLink = (text) => LINK_RE.test(text);

// ── Slow mode and presence ─────────────────────────────────────────────────

function slowModeSeconds(cfg, online) {
  if (online >= cfg.slowModeLargePeople) return cfg.slowModeLargeSeconds;
  if (online >= cfg.slowModeMediumPeople) return cfg.slowModeMediumSeconds;
  return cfg.slowModeSmallSeconds;
}

const onlineCache = new Map(); // roomId → { at, count }

async function onlineCount(roomId, { fresh = false } = {}) {
  const cached = onlineCache.get(roomId);
  if (!fresh && cached && Date.now() - cached.at < ONLINE_CACHE_MS) return cached.count;
  const count = await redis.zcount(key.online(roomId), Date.now() - PRESENCE_TTL_MS, '+inf');
  onlineCache.clear(); // only ever one live room; don't accumulate old days
  onlineCache.set(roomId, { at: Date.now(), count });
  return count;
}

async function markPresent(roomId, uid) {
  const k = key.online(roomId);
  await redis
    .multi()
    .zadd(k, Date.now(), uid)
    .zremrangebyscore(k, '-inf', Date.now() - PRESENCE_TTL_MS)
    .expire(k, ROOM_KEY_TTL_S)
    .exec();
}

const pendingPresence = new Map(); // roomId → timer

// Coalesces joins and leaves into one push per `presenceBroadcastMs`.
function schedulePresenceBroadcast(io, roomId, cfg) {
  if (!io || pendingPresence.has(roomId)) return;
  const timer = setTimeout(async () => {
    pendingPresence.delete(roomId);
    try {
      const online = await onlineCount(roomId, { fresh: true });
      io.to(roomChannel(roomId)).emit('topicChatPresence', {
        roomId,
        online,
        slowModeSeconds: slowModeSeconds(cfg, online)
      });
    } catch (err) {
      console.error('[topicChat] presence broadcast failed:', err.message);
    }
  }, cfg.presenceBroadcastMs);
  if (typeof timer.unref === 'function') timer.unref();
  pendingPresence.set(roomId, timer);
}

// ── Author snapshot ────────────────────────────────────────────────────────

const authorCache = new Map(); // uid → { at, author }

const trimmed = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Name, avatar, cosmetics and leaderboard position (1 + players with more
// rank tokens — the same number the leaderboard shows).
async function authorSnapshot(db, uid) {
  const cached = authorCache.get(uid);
  if (cached && Date.now() - cached.at < AUTHOR_CACHE_MS) return cached.author;

  const [profileSnap, userSnap] = await db.getAll(
    db.collection('publicProfiles').doc(uid),
    db.collection('users').doc(uid)
  );
  const profile = profileSnap.exists ? profileSnap.data() || {} : {};
  const user = userSnap.exists ? userSnap.data() || {} : null;

  let rank = null;
  if (user) {
    const trophies = Number.isFinite(user.rankTokens) ? user.rankTokens : 0;
    try {
      const above = await db.collection('users').where('rankTokens', '>', trophies).count().get();
      rank = above.data().count + 1;
    } catch (err) {
      console.warn('[topicChat] rank lookup failed:', err.message);
    }
  }

  const author = {
    name: trimmed(profile.name, 60) || trimmed(user && user.name, 60),
    username: trimmed(profile.username, 60),
    profileImageURL: trimmed(profile.profileImageURL || profile.imageURL, 2000),
    rank,
    equippedBadgeId: trimmed(profile.equippedBadgeId, 100),
    equippedFrameId: trimmed(profile.equippedFrameId, 100),
    equippedUsernameColorId: trimmed(profile.equippedUsernameColorId, 100)
  };

  if (authorCache.size >= AUTHOR_CACHE_MAX) authorCache.clear();
  authorCache.set(uid, { at: Date.now(), author });
  return author;
}

// ── Messages ───────────────────────────────────────────────────────────────

function newMessageId(nowMs) {
  return `${String(nowMs).padStart(13, '0')}-${crypto.randomBytes(6).toString('hex')}`;
}

// A stored message as clients receive it.
function wireMessage(data) {
  const createdAt = data.createdAt && typeof data.createdAt.toMillis === 'function'
    ? data.createdAt.toMillis()
    : Number(data.createdAt) || 0;
  return {
    id: data.id,
    roomId: data.roomId,
    userId: data.userId,
    text: data.text,
    stanceAtSend: data.stanceAtSend,
    replyToId: data.replyToId || null,
    createdAt,
    author: data.author || {}
  };
}

// One page, oldest first, ending just before `before` (or at the newest
// message). `nextBefore` is the cursor for the page before this one.
async function loadPage(db, roomId, pageSize, before = null) {
  let query = messagesRef(db, roomId).orderBy('id', 'desc');
  if (before) query = query.startAfter(before);
  const snap = await query.limit(pageSize).get();
  const docs = snap.docs.map((d) => d.data() || {});
  return {
    messages: docs.filter((d) => d.hidden !== true && d.id).map(wireMessage).reverse(),
    hasMore: docs.length === pageSize,
    nextBefore: docs.length ? docs[docs.length - 1].id || null : null
  };
}

// The newest page. Served from Redis once the room has a full page there,
// so a wave of people opening the chat doesn't each read it from Firestore.
async function loadLatest(db, roomId, pageSize) {
  try {
    const raw = await redis.lrange(key.recent(roomId), 0, pageSize - 1);
    if (raw.length >= pageSize) {
      const messages = raw
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter((m) => m && m.id)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (messages.length >= pageSize) {
        return { messages, hasMore: true, nextBefore: messages[0].id };
      }
    }
  } catch (err) {
    console.warn('[topicChat] recent cache read failed:', err.message);
  }
  return loadPage(db, roomId, pageSize);
}

async function rememberRecent(roomId, message, pageSize) {
  const k = key.recent(roomId);
  await redis
    .multi()
    .lpush(k, JSON.stringify(message))
    .ltrim(k, 0, pageSize - 1)
    .expire(k, ROOM_KEY_TTL_S)
    .exec();
}

async function forgetRecent(roomId, messageIds) {
  const k = key.recent(roomId);
  const drop = new Set(messageIds);
  const raw = await redis.lrange(k, 0, -1);
  for (const entry of raw) {
    let id = null;
    try { id = JSON.parse(entry).id; } catch { /* drop unreadable entries too */ }
    if (id === null || drop.has(id)) await redis.lrem(k, 0, entry);
  }
}

// ── Room mute (from reports) ───────────────────────────────────────────────

async function roomMutedUntil(roomId, uid) {
  const raw = await redis.get(key.muted(roomId, uid));
  const until = Number(raw);
  return Number.isFinite(until) && until > 0 ? until : null;
}

// Mutes `authorId` in the room until the topic's day ends, hides the
// messages that were reported, and flags the account for review. Returns
// false if another report got there first.
async function muteInRoom(io, { roomId, authorId, until, cfg, now }) {
  const ttlMs = Math.max(60 * 1000, until - now);
  const won = await redis.set(key.muted(roomId, authorId), String(until), 'PX', ttlMs, 'NX');
  if (won !== 'OK') return false;

  const db = requireDb();
  const admin = getAdmin();
  const [reporterIds, messageIds] = await Promise.all([
    redis.zrange(key.reports(roomId, authorId), 0, -1),
    redis.smembers(key.reported(roomId, authorId))
  ]);

  const batch = db.batch();
  batch.set(db.collection(ROOMS).doc(roomId).collection(ROOM_MUTES).doc(authorId), {
    roomId,
    userId: authorId,
    reason: 'reports',
    reporterIds,
    messageIds,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(until)
  });
  for (const id of messageIds) {
    if (MESSAGE_ID_RE.test(id)) batch.update(messagesRef(db, roomId).doc(id), { hidden: true });
  }
  await batch.commit();

  // Shows up in the admin site next to the account ("N 🚩"). Never create a
  // bare users doc for an id that has no account.
  try {
    const userRef = db.collection('users').doc(authorId);
    if ((await userRef.get()).exists) {
      await userRef.update({
        adminFlags: admin.firestore.FieldValue.arrayUnion({
          reason: `Muted in the daily chat for ${roomId}: reported by ${reporterIds.length} people within ${cfg.reportWindowMinutes} minutes.`,
          flaggedAt: admin.firestore.Timestamp.fromMillis(now),
          flaggedBy: 'auto: chat reports'
        })
      });
    }
  } catch (err) {
    console.error('[topicChat] could not flag muted user:', err.message);
  }

  try {
    await forgetRecent(roomId, messageIds);
  } catch (err) {
    console.warn('[topicChat] recent cache cleanup failed:', err.message);
  }

  if (io) {
    if (messageIds.length) io.to(roomChannel(roomId)).emit('topicChatHidden', { roomId, messageIds });
    io.to(userChannel(authorId)).emit('topicChatMuted', { roomId, mutedUntil: until });
  }
  console.log(`[topicChat] room=${roomId} muted userId=${authorId} after ${reporterIds.length} reports; hid ${messageIds.length} message(s)`);
  return true;
}

// ── Socket handlers ────────────────────────────────────────────────────────

/**
 * Registers the topic-chat events on one socket.
 * Test hooks: `opts.now()` pins the clock, `opts.accountCreatedAt(uid)`
 * replaces the Firebase Auth lookup.
 */
function registerHandlers(io, socket, userId, opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  let heartbeat = null;

  const accountCreatedAt = async () => {
    if (typeof opts.accountCreatedAt === 'function') return opts.accountCreatedAt(userId);
    if (Number.isFinite(socket.data.accountCreatedAt)) return socket.data.accountCreatedAt;
    const auth = getAuth();
    if (!auth) return null;
    const record = await auth.getUser(userId);
    const ms = Date.parse(record.metadata && record.metadata.creationTime);
    if (Number.isFinite(ms)) socket.data.accountCreatedAt = ms;
    return Number.isFinite(ms) ? ms : null;
  };

  // The room a request names must be today's. Returns the topic, or null
  // after answering `room_closed`.
  const openRoom = async (payload, reply) => {
    const topic = await dailyTopic.getTodayTopic(nowFn());
    if (typeof payload.roomId !== 'string' || payload.roomId !== topic.id) {
      reply({ ok: false, error: 'room_closed', roomId: topic.id });
      return null;
    }
    return topic;
  };

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const leaveRoom = async () => {
    stopHeartbeat();
    const roomId = socket.data.topicChatRoom;
    if (!roomId) return;
    socket.data.topicChatRoom = null;
    await socket.leave(roomChannel(roomId));
    try {
      await redis.zrem(key.online(roomId), userId);
      schedulePresenceBroadcast(io, roomId, (await loadSocialConfig()).chat);
    } catch (err) {
      console.warn('[topicChat] leave cleanup failed:', err.message);
    }
  };

  const guard = (name, handler) => async (...args) => {
    const { payload, reply } = unpack(args);
    if (!socket.data.authenticated) return reply({ ok: false, error: 'auth_required' });
    try {
      await handler(payload, reply);
    } catch (err) {
      console.error(`[${name}] failed:`, err.message);
      reply({ ok: false, error: publicError(err) });
    }
  };

  socket.on('topicChatJoin', guard('topicChatJoin', async (payload, reply) => {
    const cfg = (await loadSocialConfig()).chat;
    const topic = await openRoom(payload, reply);
    if (!topic) return;
    const roomId = topic.id;

    if (!(await dailyTopic.getStance(roomId, userId))) {
      await leaveRoom();
      return reply({ ok: false, error: 'vote_required' });
    }

    if (socket.data.topicChatRoom && socket.data.topicChatRoom !== roomId) await leaveRoom();
    await socket.join(roomChannel(roomId));
    socket.data.topicChatRoom = roomId;
    await markPresent(roomId, userId);
    stopHeartbeat();
    heartbeat = setInterval(() => {
      markPresent(roomId, userId).catch((err) => console.warn('[topicChat] heartbeat failed:', err.message));
    }, PRESENCE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const db = requireDb();
    const [page, online, cooldownMs, muteSnap] = await Promise.all([
      loadLatest(db, roomId, cfg.historyPageSize),
      onlineCount(roomId, { fresh: true }),
      redis.pttl(key.cooldown(roomId, userId)),
      db.collection(ROOMS).doc(roomId).collection(ROOM_MUTES).doc(userId).get()
    ]);

    // The mute record is the durable copy; put the fast one back if Redis lost it.
    let mutedUntil = await roomMutedUntil(roomId, userId);
    if (!mutedUntil && muteSnap.exists) {
      const expires = muteSnap.data().expiresAt;
      const until = expires && typeof expires.toMillis === 'function' ? expires.toMillis() : 0;
      if (until > nowFn()) {
        await redis.set(key.muted(roomId, userId), String(until), 'PX', Math.max(1000, until - nowFn()));
        mutedUntil = until;
      }
    }

    schedulePresenceBroadcast(io, roomId, cfg);
    reply({
      ok: true,
      roomId,
      messages: page.messages,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      online,
      slowModeSeconds: slowModeSeconds(cfg, online),
      cooldownRemainingMs: Math.max(0, cooldownMs),
      mutedUntil,
      maxMessageLength: cfg.maxMessageLength,
      serverNow: Date.now()
    });
  }));

  socket.on('topicChatLeave', guard('topicChatLeave', async (_payload, reply) => {
    await leaveRoom();
    reply({ ok: true });
  }));

  socket.on('topicChatHistory', guard('topicChatHistory', async (payload, reply) => {
    const cfg = (await loadSocialConfig()).chat;
    const topic = await openRoom(payload, reply);
    if (!topic) return;
    // Joining is what checks the vote, so history is only for sockets in the room.
    if (socket.data.topicChatRoom !== topic.id) return reply({ ok: false, error: 'not_joined' });
    if (typeof payload.before !== 'string' || !MESSAGE_ID_RE.test(payload.before)) {
      return reply({ ok: false, error: 'invalid_cursor' });
    }
    const page = await loadPage(requireDb(), topic.id, cfg.historyPageSize, payload.before);
    reply({ ok: true, roomId: topic.id, ...page });
  }));

  socket.on('topicChatSend', guard('topicChatSend', async (payload, reply) => {
    const cfg = (await loadSocialConfig()).chat;
    const text = cleanText(payload.text);
    if (!text) return reply({ ok: false, error: 'empty' });
    if (charCount(text) > cfg.maxMessageLength) {
      return reply({ ok: false, error: 'too_long', maxMessageLength: cfg.maxMessageLength });
    }

    const topic = await openRoom(payload, reply);
    if (!topic) return;
    const roomId = topic.id;

    const mutedUntil = await roomMutedUntil(roomId, userId);
    if (mutedUntil) return reply({ ok: false, error: 'room_muted', mutedUntil });

    // Slow mode. Taking the slot first (SET NX) means two sends racing from
    // two devices can't both get through.
    const online = await onlineCount(roomId);
    const gapMs = Math.round(slowModeSeconds(cfg, online) * 1000);
    const cooldownKey = key.cooldown(roomId, userId);
    const holdMs = Math.max(gapMs, REJECTED_COOLDOWN_MS);
    if ((await redis.set(cooldownKey, '1', 'PX', holdMs, 'NX')) !== 'OK') {
      const left = await redis.pttl(cooldownKey);
      return reply({ ok: false, error: 'slow_mode', retryAfterMs: left > 0 ? left : holdMs });
    }
    // The message wasn't posted: hold the sender back briefly, not for the
    // whole gap.
    const reject = async (body) => {
      await redis.set(cooldownKey, '1', 'PX', REJECTED_COOLDOWN_MS);
      reply({ ok: false, retryAfterMs: REJECTED_COOLDOWN_MS, ...body });
    };

    const stance = await dailyTopic.getStance(roomId, userId);
    if (!stance) return reject({ error: 'vote_required' });

    const candidate = comparable(text);
    if (cfg.duplicateHistory > 0) {
      const previous = await redis.lrange(key.last(roomId, userId), 0, cfg.duplicateHistory - 1);
      if (isRepeat(candidate, previous, cfg.duplicateSimilarity)) return reject({ error: 'duplicate' });
    }

    if (cfg.linkMinAccountAgeDays > 0 && containsLink(text)) {
      let createdAt = null;
      try {
        createdAt = await accountCreatedAt();
      } catch (err) {
        console.warn('[topicChatSend] account age lookup failed:', err.message);
      }
      // An account whose age can't be read is treated as new.
      const ageDays = Number.isFinite(createdAt) ? (nowFn() - createdAt) / DAY_MS : 0;
      if (ageDays < cfg.linkMinAccountAgeDays) {
        return reject({ error: 'links_not_allowed', minAccountAgeDays: cfg.linkMinAccountAgeDays });
      }
    }

    if (!checkText(text, { allowWords: cfg.filterAllowWords }).allowed) return reject({ error: 'filtered' });

    const db = requireDb();
    const admin = getAdmin();
    const author = await authorSnapshot(db, userId);
    const sentAt = Date.now();
    const id = newMessageId(sentAt);
    const stored = {
      id,
      roomId,
      userId,
      text,
      stanceAtSend: stance,
      replyToId: null,
      createdAt: admin.firestore.Timestamp.fromMillis(sentAt),
      hidden: false,
      author
    };
    try {
      await messagesRef(db, roomId).doc(id).create(stored);
    } catch (err) {
      await redis.set(cooldownKey, '1', 'PX', REJECTED_COOLDOWN_MS).catch(() => {});
      throw err;
    }

    const message = wireMessage(stored);
    io.to(roomChannel(roomId)).emit('topicChatMessage', message);
    reply({ ok: true, message, slowModeSeconds: gapMs / 1000, retryAfterMs: gapMs });

    try {
      if (gapMs < holdMs) await redis.set(cooldownKey, '1', 'PX', Math.max(1, gapMs));
      const lastKey = key.last(roomId, userId);
      const ops = redis.multi();
      if (cfg.duplicateHistory > 0) {
        ops.lpush(lastKey, candidate).ltrim(lastKey, 0, cfg.duplicateHistory - 1).expire(lastKey, ROOM_KEY_TTL_S);
      }
      await ops.exec();
      await rememberRecent(roomId, message, cfg.historyPageSize);
    } catch (err) {
      console.warn('[topicChatSend] post-send bookkeeping failed:', err.message);
    }
  }));

  socket.on('topicChatReport', guard('topicChatReport', async (payload, reply) => {
    const cfg = (await loadSocialConfig()).chat;
    const topic = await openRoom(payload, reply);
    if (!topic) return;
    const roomId = topic.id;
    if (socket.data.topicChatRoom !== roomId) return reply({ ok: false, error: 'not_joined' });

    const messageId = payload.messageId;
    if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
      return reply({ ok: false, error: 'not_found' });
    }
    const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, MAX_REASON_LENGTH) : '';
    if (!reason) return reply({ ok: false, error: 'reason_required' });

    const db = requireDb();
    const admin = getAdmin();
    const messageSnap = await messagesRef(db, roomId).doc(messageId).get();
    if (!messageSnap.exists) return reply({ ok: false, error: 'not_found' });
    const message = messageSnap.data() || {};
    const authorId = message.userId;
    if (!authorId || authorId === userId) return reply({ ok: false, error: 'own_message' });

    const windowMs = Math.round(cfg.reportWindowMinutes * 60 * 1000);
    const countKey = key.reportCount(userId);
    const filed = await redis.incr(countKey);
    if (filed === 1) await redis.pexpire(countKey, windowMs);
    if (filed > cfg.reportsPerUserLimit) return reply({ ok: false, error: 'report_limit' });

    try {
      await db.collection(REPORTS).doc(`${userId}_message_${messageId}`).create({
        reporterId: userId,
        targetType: 'message',
        targetId: messageId,
        reason,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        roomId,
        targetUserId: authorId,
        text: typeof message.text === 'string' ? message.text : '',
        status: 'open'
      });
    } catch (err) {
      if (err.code === GRPC_ALREADY_EXISTS) return reply({ ok: false, error: 'already_reported' });
      throw err;
    }

    // Distinct reporters against this author inside the window.
    const now = Date.now();
    const reportsKey = key.reports(roomId, authorId);
    const reportedKey = key.reported(roomId, authorId);
    const results = await redis
      .multi()
      .zadd(reportsKey, now, userId)
      .zremrangebyscore(reportsKey, '-inf', now - windowMs)
      .zcard(reportsKey)
      .pexpire(reportsKey, windowMs)
      .sadd(reportedKey, messageId)
      .expire(reportedKey, ROOM_KEY_TTL_S)
      .exec();
    const reporters = Number(results[2] && results[2][1]) || 0;

    let muted = false;
    if (reporters >= cfg.reportThreshold) {
      muted = await muteInRoom(io, { roomId, authorId, until: topic.endsAt, cfg, now: nowFn() });
    }
    console.log(`[topicChatReport] reporter=${userId} author=${authorId} message=${messageId} reporters=${reporters}${muted ? ' → muted' : ''}`);
    reply({ ok: true });
  }));

  // ── Muting another user (hides their messages for the muter) ────────────

  const mutesRef = () => requireDb().collection('users').doc(userId).collection('mutes');

  socket.on('muteUser', guard('muteUser', async (payload, reply) => {
    const target = payload.userId;
    if (typeof target !== 'string' || !USER_ID_RE.test(target)) return reply({ ok: false, error: 'invalid_user' });
    if (target === userId) return reply({ ok: false, error: 'own_account' });
    const db = requireDb();
    const existing = await mutesRef().count().get();
    if (existing.data().count >= MAX_MUTED_LIST) return reply({ ok: false, error: 'mute_limit' });
    const author = await authorSnapshot(db, target);
    await mutesRef().doc(target).set({
      userId,
      mutedUserId: target,
      createdAt: getAdmin().firestore.FieldValue.serverTimestamp(),
      name: author.name,
      username: author.username,
      profileImageURL: author.profileImageURL
    });
    reply({ ok: true, userId: target });
  }));

  socket.on('unmuteUser', guard('unmuteUser', async (payload, reply) => {
    const target = payload.userId;
    if (typeof target !== 'string' || !USER_ID_RE.test(target)) return reply({ ok: false, error: 'invalid_user' });
    await mutesRef().doc(target).delete();
    reply({ ok: true, userId: target });
  }));

  socket.on('mutedUsers', guard('mutedUsers', async (_payload, reply) => {
    const snap = await mutesRef().limit(MAX_MUTED_LIST).get();
    const users = snap.docs
      .map((d) => {
        const data = d.data() || {};
        const createdAt = data.createdAt && typeof data.createdAt.toMillis === 'function' ? data.createdAt.toMillis() : 0;
        return {
          userId: d.id,
          name: data.name || null,
          username: data.username || null,
          profileImageURL: data.profileImageURL || null,
          createdAt
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    reply({ ok: true, users });
  }));

  socket.on('disconnect', () => {
    leaveRoom().catch((err) => console.warn('[topicChat] disconnect cleanup failed:', err.message));
  });
}

function _resetForTests() {
  onlineCache.clear();
  authorCache.clear();
  for (const timer of pendingPresence.values()) clearTimeout(timer);
  pendingPresence.clear();
}

module.exports = {
  registerHandlers,
  roomChannel,
  // exported for tests
  authorSnapshot,
  cleanText,
  comparable,
  similarity,
  containsLink,
  slowModeSeconds,
  _resetForTests
};
