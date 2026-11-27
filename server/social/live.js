// social/live.js — the daily live debate: one topic a day, everybody picks
// Support or Oppose and argues in one real-time stream.
//
//   dailyTopics/{YYYY-MM-DD}                     (see dailyTopic.js) + supportCount, opposeCount, messageCount
//   dailyTopics/{date}/sides/{uid}               { side 'support' | 'oppose', updatedAt }
//   dailyTopics/{date}/liveMessages/{id}
//     id, userId, side (the author's side when they wrote it), text, createdAt,
//     agreeCount, replyTo { id, userId, text } | null,
//     kind 'message' | 'challenge' (+ challengeId for a "Challenge sent" card)
//   dailyTopics/{date}/liveMessages/{id}/agrees/{uid}   { createdAt }
//
// The topic changes at midnight in the configured timezone (US Central).
// The stream stays open all day; when the day ends it becomes read-only and
// shows up in the archive.
//
// Spam guard, all enforced here:
//   • one message every `live.messageCooldownSeconds` (10 s) per user;
//   • a user can't post a message identical to one they already posted today;
//   • nobody can post a message identical to one posted in the last minute.
// "Identical" ignores case, accents, punctuation and spacing.
//
// Socket events:
//   liveState                                     → { topic, side, support, oppose, debating, cooldownMs }
//   liveJoin     { topicId? }                     → state + { messages, next } and joins the stream
//   liveLeave
//   liveSide     { side }                         → { side, support, oppose, debating }
//   liveHistory  { topicId, cursor }              → { messages, next }   (older messages)
//   liveSend     { topicId, text, replyToId? }    → { message, cooldownMs }
//   liveAgree    { topicId, messageId, on }       → { agreed, agreeCount }
//   liveDelete   { topicId, messageId }
//   liveArchive  { cursor? }                      → { items, next }      (past topics)
//   adminTopics                                   → { today, topics }    (admins)
//   adminTopicSave   { date, statement, category? }
//   adminTopicDelete { date }
//   server → `live:{topicId}`: liveMessage, liveAgree, liveRemoved, liveChallenge
//   server → everyone: liveCounts { topicId, support, oppose, debating }, liveTopicChanged { topic }

const core = require('./core');
const dailyTopic = require('../dailyTopic');
const notifications = require('./notifications');
const { shiftDayKey } = require('../timeUtil');

const DAY_MS = 24 * 60 * 60 * 1000;
const ECHO_WINDOW_MS = 60 * 1000;
const ARCHIVE_PAGE = 30;
const ADMIN_LOOKBACK_DAYS = 14;
const ADMIN_MAX_DAYS_AHEAD = 365;
const MIN_STATEMENT_LENGTH = 8;
const ROLLOVER_CHECK_MS = 2000;

const topics = () => core.requireDb().collection(dailyTopic.COLLECTION);
const topicRef = (topicId) => topics().doc(topicId);
const messagesRef = (topicId) => topicRef(topicId).collection('liveMessages');
const sideRef = (topicId, uid) => topicRef(topicId).collection('sides').doc(uid);
const agreeRef = (topicId, messageId, uid) => messagesRef(topicId).doc(messageId).collection('agrees').doc(uid);
const room = (topicId) => `live:${topicId}`;
const byId = () => core.FieldPath().documentId();
const validSide = (v) => (v === 'support' || v === 'oppose' ? v : null);

function requireTopicId(value) {
  if (typeof value !== 'string' || !core.DAY_KEY_RE.test(value)) throw core.clientError('bad_request');
  return value;
}

// Older topics counted votes as agree / disagree.
const counts = (data) => {
  const support = core.count(data.supportCount ?? data.agreeCount);
  const oppose = core.count(data.opposeCount ?? data.disagreeCount);
  return { support, oppose, debating: support + oppose };
};

// ── Reading ────────────────────────────────────────────────────────────────

async function state(userId) {
  const cfg = (await core.loadSocialConfig()).live;
  const topic = await dailyTopic.getTodayTopic();
  const [topicSnap, sideSnap, cooldownMs] = await Promise.all([
    topicRef(topic.id).get(),
    sideRef(topic.id, userId).get(),
    core.cooldownLeft('live', userId)
  ]);
  return {
    topic: { id: topic.id, statement: topic.statement, category: topic.category, endsAt: topic.endsAt },
    side: sideSnap.exists ? validSide(sideSnap.get('side')) : null,
    ...counts(topicSnap.data() || {}),
    cooldownMs,
    cooldownSeconds: cfg.messageCooldownSeconds,
    maxLength: cfg.maxMessageLength,
    serverTime: Date.now()
  };
}

/** Stored messages → what the app draws for `viewerId` (blocked authors dropped). */
async function hydrate(topicId, docs, viewerId) {
  if (!docs.length) return [];
  const db = core.requireDb();
  const blocked = await core.blockedBy(viewerId);
  const visible = docs.filter((d) => d.kind === 'challenge' || !blocked.has(d.userId));
  if (!visible.length) return [];

  const cardIds = visible.filter((d) => d.kind === 'challenge' && d.challengeId).map((d) => d.challengeId);
  const [users, agreeSnaps, cards] = await Promise.all([
    core.getUsers(visible.flatMap((d) => [d.userId, d.replyTo && d.replyTo.userId])),
    db.getAll(...visible.map((d) => agreeRef(topicId, d.id, viewerId))),
    cardIds.length ? require('./challenges').wireMany(cardIds, viewerId) : new Map()
  ]);

  return visible
    .map((d, i) => ({
      id: d.id,
      topicId,
      kind: d.kind || 'message',
      author: users.get(d.userId),
      side: validSide(d.side),
      text: d.text || '',
      createdAt: d.createdAt || core.idTime(d.id),
      agreeCount: core.count(d.agreeCount),
      agreed: agreeSnaps[i].exists,
      replyTo:
        d.replyTo && !blocked.has(d.replyTo.userId)
          ? { id: d.replyTo.id, author: users.get(d.replyTo.userId), text: d.replyTo.text || '' }
          : null,
      challenge: d.kind === 'challenge' ? cards.get(d.challengeId) || null : null
    }))
    .filter((m) => m.kind !== 'challenge' || m.challenge);
}

// One page, newest at the bottom; `next` is the cursor for older messages.
async function history(topicId, cursor, viewerId, size) {
  // By the `id` field: document ids are only indexed ascending.
  let query = messagesRef(topicId).orderBy('id', 'desc');
  if (cursor) query = query.startAfter(cursor);
  const snap = await query.limit(size).get();
  const docs = snap.docs.map((d) => d.data() || {});
  return {
    messages: (await hydrate(topicId, docs, viewerId)).reverse(),
    next: docs.length === size ? docs[docs.length - 1].id : null
  };
}

// ── Live pushes ────────────────────────────────────────────────────────────

const debounceCounts = core.makeDebouncer(500);

function pushCounts(io, topicId) {
  if (!io) return;
  debounceCounts(topicId, async () => {
    const snap = await topicRef(topicId).get();
    io.to(core.ROOM_ALL).emit('liveCounts', { topicId, ...counts(snap.data() || {}) });
  });
}

/** Adds the "Challenge sent" card to the stream. */
async function addChallengeCard(io, { topicId, challengeId, fromId }) {
  const now = Date.now();
  const card = {
    id: core.newId(now),
    userId: fromId,
    side: null,
    text: '',
    createdAt: now,
    agreeCount: 0,
    replyTo: null,
    kind: 'challenge',
    challengeId
  };
  await messagesRef(topicId).doc(card.id).create(card);
  if (io) {
    const [wire] = await hydrate(topicId, [card], fromId);
    if (wire) {
      io.to(room(topicId)).emit('liveMessage', {
        topicId,
        message: { ...wire, agreed: false, challenge: { ...wire.challenge, reminding: false } }
      });
    }
  }
  return card.id;
}

/** Tells the stream that a challenge shown in it changed. */
function pushChallenge(io, topicId, challenge) {
  if (io && topicId) io.to(room(topicId)).emit('liveChallenge', { topicId, challenge });
}

// ── A deleted account ──────────────────────────────────────────────────────

/**
 * Removes everything one person wrote in the live debates, and their side
 * picks. Past days keep their final split (the result of a finished debate
 * doesn't change because someone later left); today's is corrected.
 */
async function removeUser(io, uid) {
  const db = core.requireDb();
  const { key: today } = await dailyTopic.today();
  const snap = await topics().select().get();
  const days = snap.docs.map((d) => d.id).filter((id) => core.DAY_KEY_RE.test(id));

  const clearDay = async (day) => {
    const [mine, side] = await Promise.all([messagesRef(day).where('userId', '==', uid).get(), sideRef(day, uid).get()]);
    if (!mine.size && !side.exists) return;

    for (let i = 0; i < mine.docs.length; i += 400) {
      const batch = db.batch();
      mine.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    const written = mine.docs.filter((d) => d.get('kind') !== 'challenge').length;
    if (written) await topicRef(day).set({ messageCount: core.FieldValue().increment(-written) }, { merge: true });
    // Agree markers under the deleted messages are unreachable now.
    mine.docs.forEach((d) => {
      d.ref
        .collection('agrees')
        .limit(500)
        .get()
        .then((agrees) => Promise.all(agrees.docs.map((a) => a.ref.delete())))
        .catch(() => {});
    });

    if (side.exists) {
      await db.runTransaction(async (tx) => {
        const [topicSnap, sideSnap] = await tx.getAll(topicRef(day), sideRef(day, uid));
        if (!sideSnap.exists) return;
        const picked = validSide(sideSnap.get('side'));
        tx.delete(sideRef(day, uid));
        if (picked && day === today && topicSnap.exists) {
          const now = counts(topicSnap.data() || {});
          tx.set(topicRef(day), { [`${picked}Count`]: Math.max(0, now[picked] - 1) }, { merge: true });
        }
      });
    }

    if (day === today && io) {
      mine.docs.forEach((d) => io.to(room(day)).emit('liveRemoved', { topicId: day, messageId: d.id }));
      pushCounts(io, day);
    }
  };

  for (let i = 0; i < days.length; i += 10) {
    await Promise.all(days.slice(i, i + 10).map(clearDay));
  }
}

// ── Midnight ───────────────────────────────────────────────────────────────

let watcher = null;
let watchedDay = null;

async function announceTopic(io, { local }) {
  const topic = await dailyTopic.getTodayTopic();
  const snap = await topicRef(topic.id).get();
  const payload = {
    topic: { id: topic.id, statement: topic.statement, category: topic.category, endsAt: topic.endsAt },
    ...counts(snap.data() || {}),
    serverTime: Date.now()
  };
  (local ? io.local : io).to(core.ROOM_ALL).emit('liveTopicChanged', payload);
}

/** Tells this instance's sockets when the day (and so the topic) changes. */
function start(io) {
  if (watcher) return;
  watcher = setInterval(async () => {
    try {
      const { key } = await dailyTopic.today();
      if (watchedDay === null) watchedDay = key;
      if (key === watchedDay) return;
      watchedDay = key;
      await announceTopic(io, { local: true });
    } catch (err) {
      console.error('[live] rollover check failed:', err.message);
    }
  }, ROLLOVER_CHECK_MS);
  if (typeof watcher.unref === 'function') watcher.unref();
}

function stop() {
  if (watcher) clearInterval(watcher);
  watcher = null;
  watchedDay = null;
}

// ── Socket events ──────────────────────────────────────────────────────────

function register({ io, socket, on, userId }) {
  let joined = null;

  const leave = async () => {
    if (joined) await socket.leave(room(joined));
    joined = null;
  };

  // Only today's topic can be argued about.
  const requireToday = async (topicId) => {
    const topic = await dailyTopic.getTodayTopic();
    if (requireTopicId(topicId) !== topic.id) throw core.clientError('closed', { topicId: topic.id });
    return topic;
  };

  on('liveState', () => state(userId));

  on('liveJoin', async (payload) => {
    const cfg = (await core.loadSocialConfig()).live;
    const current = await state(userId);
    const topicId = payload.topicId ? requireTopicId(payload.topicId) : current.topic.id;

    if (topicId === current.topic.id) {
      await leave();
      await socket.join(room(topicId));
      joined = topicId;
      return { ...current, isToday: true, ...(await history(topicId, null, userId, cfg.historyPageSize)) };
    }

    // A past topic, read-only.
    if (topicId > current.topic.id) throw core.clientError('not_found');
    const [snap, sideSnap] = await Promise.all([topicRef(topicId).get(), sideRef(topicId, userId).get()]);
    const data = snap.exists ? snap.data() || {} : null;
    const statement = data ? dailyTopic.cleanStatement(data.statement) : '';
    if (!statement) throw core.clientError('not_found');
    return {
      topic: { id: topicId, statement, category: dailyTopic.normalizeCategory(data.category), endsAt: null },
      side: sideSnap.exists ? validSide(sideSnap.get('side')) : null,
      ...counts(data),
      cooldownMs: 0,
      isToday: false,
      serverTime: Date.now(),
      ...(await history(topicId, null, userId, cfg.historyPageSize))
    };
  });

  on('liveLeave', async () => {
    await leave();
    return {};
  });

  on('liveHistory', async (payload) => {
    const cfg = (await core.loadSocialConfig()).live;
    const topicId = requireTopicId(payload.topicId);
    const cursor = core.optionalId(payload.cursor);
    if (!cursor) throw core.clientError('bad_request');
    return history(topicId, cursor, userId, cfg.historyPageSize);
  });

  on('liveSide', async (payload) => {
    const cfg = (await core.loadSocialConfig()).live;
    const side = validSide(payload.side);
    if (!side) throw core.clientError('bad_request');
    const topic = await dailyTopic.getTodayTopic();
    const wait = await core.cooldown('liveSide', userId, cfg.sideCooldownMs);
    if (wait > 0) throw core.clientError('rate_limited', { retryInMs: wait });

    const db = core.requireDb();
    const result = await db.runTransaction(async (tx) => {
      const [topicSnap, mine] = await tx.getAll(topicRef(topic.id), sideRef(topic.id, userId));
      const now = counts(topicSnap.data() || {});
      const previous = mine.exists ? validSide(mine.get('side')) : null;
      if (previous !== side) {
        if (previous) now[previous] = Math.max(0, now[previous] - 1);
        now[side] += 1;
        tx.set(sideRef(topic.id, userId), { side, updatedAt: Date.now() });
        tx.set(topicRef(topic.id), { supportCount: now.support, opposeCount: now.oppose }, { merge: true });
      }
      return { support: now.support, oppose: now.oppose, debating: now.support + now.oppose };
    });
    pushCounts(io, topic.id);
    return { topicId: topic.id, side, ...result };
  });

  on('liveSend', async (payload) => {
    const cfg = (await core.loadSocialConfig()).live;
    const topic = await requireToday(payload.topicId);
    const text = await core.validText(payload.text, { max: cfg.maxMessageLength });
    const replyToId = core.optionalId(payload.replyToId);

    const [sideSnap, replySnap] = await Promise.all([
      sideRef(topic.id, userId).get(),
      replyToId ? messagesRef(topic.id).doc(replyToId).get() : null
    ]);
    const side = sideSnap.exists ? validSide(sideSnap.get('side')) : null;
    if (!side) throw core.clientError('side_required');
    const parent = replySnap && replySnap.exists ? replySnap.data() : null;
    if (parent && parent.kind !== 'challenge') await core.assertNoBlock(userId, parent.userId);

    // Spam guard: the clock first, then the two "already said" checks. A
    // refused message gives the slot back, so only a sent one costs 10 s.
    const cooldownMs = cfg.messageCooldownSeconds * 1000;
    const wait = await core.cooldown('live', userId, cooldownMs);
    if (wait > 0) throw core.clientError('rate_limited', { retryInMs: wait });

    const now = Date.now();
    const hash = core.textHash(text);
    const saidKey = `live:said:${topic.id}:${userId}`;
    const echoKey = `live:echo:${topic.id}:${hash}`;
    let tookSaid = false;
    let tookEcho = false;
    const giveBack = async () => {
      await Promise.all([
        core.clearCooldown('live', userId),
        tookSaid ? core.redis.zrem(saidKey, hash) : null,
        tookEcho ? core.redis.del(echoKey) : null
      ]);
    };

    let message;
    try {
      tookSaid = (await core.redis.zadd(saidKey, 'NX', now, hash)) === 1;
      if (!tookSaid) throw core.clientError('duplicate', { scope: 'yours' });
      tookEcho = (await core.redis.set(echoKey, userId, 'PX', ECHO_WINDOW_MS, 'NX')) === 'OK';
      if (!tookEcho) throw core.clientError('duplicate', { scope: 'recent' });

      message = {
        id: core.newId(now),
        userId,
        side,
        text,
        createdAt: now,
        agreeCount: 0,
        replyTo:
          parent && parent.kind !== 'challenge'
            ? { id: parent.id, userId: parent.userId, text: core.clip(parent.text || '', 140) }
            : null,
        kind: 'message'
      };
      const batch = core.requireDb().batch();
      batch.create(messagesRef(topic.id).doc(message.id), message);
      batch.set(topicRef(topic.id), { messageCount: core.FieldValue().increment(1) }, { merge: true });
      await batch.commit();
    } catch (err) {
      await giveBack().catch(() => {});
      throw err;
    }

    core.redis
      .multi()
      .zremrangebyrank(saidKey, 0, -(cfg.repeatMemory + 1))
      .pexpire(saidKey, DAY_MS + 2 * 60 * 60 * 1000)
      .exec()
      .catch(() => {});

    const [wire] = await hydrate(topic.id, [message], userId);
    io.to(room(topic.id)).emit('liveMessage', { topicId: topic.id, message: { ...wire, agreed: false } });

    if (message.replyTo) {
      notifications.notify(io, message.replyTo.userId, {
        type: 'reply',
        actorId: userId,
        topicId: topic.id,
        messageId: message.id,
        text: core.clip(text, 140)
      });
    }
    return { message: wire, cooldownMs };
  });

  on('liveAgree', async (payload) => {
    // A finished day is read-only.
    const topicId = (await requireToday(payload.topicId)).id;
    const messageId = core.requireId(payload.messageId);
    const turnOn = payload.on !== false;
    await core.rateLimit('liveAgree', userId, 120, 60 * 1000);

    const db = core.requireDb();
    const messageRef = messagesRef(topicId).doc(messageId);
    const marker = agreeRef(topicId, messageId, userId);
    const result = await db.runTransaction(async (tx) => {
      const [messageSnap, markerSnap] = await tx.getAll(messageRef, marker);
      const message = messageSnap.exists ? messageSnap.data() : null;
      if (!message || message.kind === 'challenge') throw core.clientError('not_found');
      let agreeCount = core.count(message.agreeCount);
      const changed = markerSnap.exists !== turnOn;
      if (changed) {
        agreeCount = Math.max(0, agreeCount + (turnOn ? 1 : -1));
        if (turnOn) tx.set(marker, { createdAt: Date.now() });
        else tx.delete(marker);
        tx.update(messageRef, { agreeCount });
      }
      return { changed, agreeCount, authorId: message.userId, text: message.text };
    });

    if (result.changed) {
      io.to(room(topicId)).emit('liveAgree', { topicId, messageId, agreeCount: result.agreeCount });
      const key = `live_${messageId}_${userId}`;
      if (turnOn) {
        notifications.notify(io, result.authorId, {
          type: 'like',
          actorId: userId,
          key,
          topicId,
          messageId,
          text: core.clip(result.text || '', 140)
        });
      } else {
        notifications.retract(io, result.authorId, 'like', key);
      }
    }
    return { agreed: turnOn, agreeCount: result.agreeCount };
  });

  on('liveDelete', async (payload) => {
    const topicId = requireTopicId(payload.topicId);
    const messageId = core.requireId(payload.messageId);
    const messageRef = messagesRef(topicId).doc(messageId);
    const snap = await messageRef.get();
    const message = snap.exists ? snap.data() : null;
    if (!message || message.kind === 'challenge') throw core.clientError('not_found');
    if (message.userId !== userId) {
      const account = await core.loadAccount(socket, userId);
      if (!account.isAdmin) throw core.clientError('not_allowed');
    }
    const batch = core.requireDb().batch();
    batch.delete(messageRef);
    batch.set(topicRef(topicId), { messageCount: core.FieldValue().increment(-1) }, { merge: true });
    await batch.commit();
    io.to(room(topicId)).emit('liveRemoved', { topicId, messageId });
    // Agree markers are swept in the background; they are unreachable now.
    messageRef
      .collection('agrees')
      .limit(500)
      .get()
      .then((agrees) => Promise.all(agrees.docs.map((d) => d.ref.delete())))
      .catch(() => {});
    return {};
  });

  on('liveArchive', async (payload) => {
    const { key } = await dailyTopic.today();
    const cursor = typeof payload.cursor === 'string' && core.DAY_KEY_RE.test(payload.cursor) ? payload.cursor : key;
    const before = cursor < key ? cursor : key;
    // `activeDate` always equals the document id (ids are only indexed ascending).
    const snap = await topics().orderBy('activeDate', 'desc').startAfter(before).limit(ARCHIVE_PAGE).get();
    const items = snap.docs
      .map((d) => ({ id: d.id, data: d.data() || {} }))
      .filter((t) => core.DAY_KEY_RE.test(t.id) && dailyTopic.cleanStatement(t.data.statement))
      .map((t) => ({
        id: t.id,
        statement: dailyTopic.cleanStatement(t.data.statement),
        category: dailyTopic.normalizeCategory(t.data.category),
        ...counts(t.data),
        messageCount: core.count(t.data.messageCount)
      }));
    return { items, next: snap.size === ARCHIVE_PAGE ? snap.docs[snap.docs.length - 1].id : null };
  });

  // ── Scheduling (admins) ──────────────────────────────────────────────────

  const requireDate = async (value, { allowToday }) => {
    const date = requireTopicId(value);
    const parsed = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed) || shiftDayKey(date, 0) !== date) throw core.clientError('bad_date');
    const { key } = await dailyTopic.today();
    if (date < key || (!allowToday && date === key)) throw core.clientError('past_date', { today: key });
    if (date > shiftDayKey(key, ADMIN_MAX_DAYS_AHEAD)) throw core.clientError('bad_date');
    return { date, today: key };
  };

  const adminRow = (id, data) => ({
    date: id,
    statement: dailyTopic.cleanStatement(data.statement),
    category: dailyTopic.normalizeCategory(data.category),
    source: data.source === 'fallback' ? 'fallback' : 'admin',
    ...counts(data),
    messageCount: core.count(data.messageCount)
  });

  on(
    'adminTopics',
    async () => {
      const { key } = await dailyTopic.today();
      const snap = await topics()
        .orderBy(byId(), 'asc')
        .startAt(shiftDayKey(key, -ADMIN_LOOKBACK_DAYS))
        .endAt(shiftDayKey(key, ADMIN_MAX_DAYS_AHEAD))
        .get();
      return {
        today: key,
        categories: dailyTopic.CATEGORY_KEYS,
        maxLength: dailyTopic.MAX_STATEMENT_LENGTH,
        topics: snap.docs
          .filter((d) => core.DAY_KEY_RE.test(d.id))
          .map((d) => adminRow(d.id, d.data() || {}))
          .filter((t) => t.statement)
      };
    },
    { admin: true }
  );

  on(
    'adminTopicSave',
    async (payload) => {
      const { date, today } = await requireDate(payload.date, { allowToday: true });
      const raw = core.cleanLine(payload.statement);
      if (core.charCount(raw) > dailyTopic.MAX_STATEMENT_LENGTH) {
        throw core.clientError('too_long', { max: dailyTopic.MAX_STATEMENT_LENGTH });
      }
      const statement = dailyTopic.cleanStatement(raw);
      if (core.charCount(statement) < MIN_STATEMENT_LENGTH) throw core.clientError('too_short', { min: MIN_STATEMENT_LENGTH });

      const db = core.requireDb();
      const saved = await db.runTransaction(async (tx) => {
        const snap = await tx.get(topicRef(date));
        const fields = {
          id: date,
          statement,
          category: dailyTopic.normalizeCategory(payload.category),
          activeDate: date,
          source: 'admin',
          updatedBy: userId,
          updatedAt: core.FieldValue().serverTimestamp()
        };
        if (snap.exists) {
          tx.set(topicRef(date), fields, { merge: true });
          return { ...snap.data(), ...fields };
        }
        const created = { ...fields, supportCount: 0, opposeCount: 0, messageCount: 0 };
        tx.set(topicRef(date), { ...created, createdAt: core.FieldValue().serverTimestamp() });
        return created;
      });

      if (date === today) {
        dailyTopic.forgetTopicCache();
        await announceTopic(io, { local: false });
      }
      return { topic: adminRow(date, saved) };
    },
    { admin: true }
  );

  on(
    'adminTopicDelete',
    async (payload) => {
      const { date } = await requireDate(payload.date, { allowToday: false });
      await topicRef(date).delete();
      return { date };
    },
    { admin: true }
  );

  socket.on('disconnect', () => {
    joined = null;
  });
}

module.exports = { register, start, stop, addChallengeCard, pushChallenge, removeUser, room };
