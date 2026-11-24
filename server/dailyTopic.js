// dailyTopic.js — the Today tab's daily topic and its vote.
//
// One topic per day. The day rolls over at local midnight in the configured
// timezone (siteSettings/social → dailyTopic.timezone, US Central by default).
//
// Firestore (written only here, through the Admin SDK; clients cannot read
// or write any of it):
//
//   dailyTopics/{YYYY-MM-DD}
//     id, statement, category, activeDate, agreeCount, disagreeCount,
//     noStanceCount, source ('admin' | 'fallback'), createdAt
//   dailyTopics/{YYYY-MM-DD}/votes/{uid}
//     topicId, userId, stance, changeCount, updatedAt
//   users/{uid}.voteStreak, users/{uid}.lastVoteDate
//
// The doc id IS the active date, so there can only be one topic per day, and
// the vote doc id IS the user id, so there can only be one vote per user per
// topic. An admin schedules a topic by creating the doc for a date ahead of
// time; if no doc exists when the day starts, the most-debated topic of the
// last few days is used instead.
//
// A vote and its effect on the counters commit in one transaction, so the
// counters on the topic doc always equal the votes underneath it.
//
// Results are hidden until you vote: counts are only ever sent to sockets in
// the topic's voters room, which a socket joins after its user has voted.
//
// Socket events (all need a verified-token socket, all answer via ack):
//   dailyTopicState                      → topic, my vote, counts (voters only), streak
//   dailyTopicVote { topicId, stance, change } → cast (change=false) or change (change=true)
//   dailyTopicCounts (server → voters)   → live counts

const { getDb, getAdmin } = require('./firestoreClient');
const { client: redis } = require('./redisClient');
const { loadSocialConfig } = require('./socialConfig');
const { dayKeyInZone, nextMidnightMsInZone, shiftDayKey } = require('./timeUtil');
const { pickTrendingQuestion, LIVE_TOPIC_META, TRENDING_GAME_TYPE } = require('./topicDebate');

const COLLECTION = 'dailyTopics';
const STANCES = ['agree', 'disagree', 'noStance'];
const COUNT_FIELD = {
  agree: 'agreeCount',
  disagree: 'disagreeCount',
  noStance: 'noStanceCount'
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TOPIC_CACHE_MS = 30 * 1000;
const COUNTS_CACHE_MS = 250;
// Debates scanned to find the most-debated topic (once per day, at most).
const FALLBACK_SCAN_LIMIT = 500;
// A fallback never repeats a statement used as the daily topic this recently.
const NO_REPEAT_DAYS = 7;
const MAX_STATEMENT_LENGTH = 300;
const GRPC_ALREADY_EXISTS = 6;

const CATEGORY_KEYS = Object.keys(LIVE_TOPIC_META).filter((k) => k !== 'custom');

function votersRoom(topicId) {
  return `dailyTopic:${topicId}:voters`;
}

function serviceError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function requireDb() {
  const db = getDb();
  if (!db) throw serviceError('unavailable');
  return db;
}

function cleanStatement(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_STATEMENT_LENGTH);
}

function normalizeCategory(raw) {
  return CATEGORY_KEYS.includes(raw) ? raw : TRENDING_GAME_TYPE;
}

function statementKey(statement) {
  return cleanStatement(statement).toLowerCase();
}

// ── Fallback topic ─────────────────────────────────────────────────────────

async function recentStatementKeys(db, dayKey) {
  const refs = [];
  for (let i = 1; i <= NO_REPEAT_DAYS; i++) {
    refs.push(db.collection(COLLECTION).doc(shiftDayKey(dayKey, -i)));
  }
  const used = new Set();
  try {
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap) => {
      if (snap.exists) used.add(statementKey(snap.data().statement));
    });
  } catch (err) {
    console.warn('[dailyTopic] could not read recent topics:', err.message);
  }
  used.delete('');
  return used;
}

// The question debated most often in the lookback window (custom debates
// excluded — those are player-written and unreviewed).
async function mostDebatedTopic(db, cfg, now, excluded) {
  const admin = getAdmin();
  const since = admin.firestore.Timestamp.fromMillis(now - cfg.fallbackLookbackDays * DAY_MS);
  const snap = await db
    .collection('debates')
    .where('createdAt', '>=', since)
    .orderBy('createdAt', 'desc')
    .limit(FALLBACK_SCAN_LIMIT)
    .select('questionId', 'questionText', 'categoryId')
    .get();

  const tally = new Map();
  let order = 0;
  snap.forEach((doc) => {
    const d = doc.data() || {};
    const statement = cleanStatement(d.questionText);
    if (!d.questionId || !statement || d.categoryId === 'custom') return;
    if (excluded.has(statementKey(statement))) return;
    const entry = tally.get(d.questionId) || {
      count: 0,
      statement,
      category: normalizeCategory(d.categoryId),
      questionId: d.questionId,
      order: order++ // lower = debated more recently
    };
    entry.count += 1;
    tally.set(d.questionId, entry);
  });

  let best = null;
  for (const entry of tally.values()) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.order < best.order)) {
      best = entry;
    }
  }
  return best;
}

async function pickFallbackTopic(db, cfg, dayKey, now) {
  const excluded = await recentStatementKeys(db, dayKey);

  try {
    const best = await mostDebatedTopic(db, cfg, now, excluded);
    if (best) {
      return { statement: best.statement, category: best.category, sourceQuestionId: best.questionId, debateCount: best.count };
    }
  } catch (err) {
    console.warn('[dailyTopic] most-debated lookup failed:', err.message);
  }

  // Nothing debated recently: a live question from the trending pool.
  try {
    const live = await pickTrendingQuestion([], TRENDING_GAME_TYPE);
    const statement = cleanStatement(live && live.question);
    if (statement && !excluded.has(statementKey(statement))) {
      return { statement, category: TRENDING_GAME_TYPE, sourceQuestionId: live.questionId || null, debateCount: 0 };
    }
  } catch (err) {
    console.warn('[dailyTopic] live question lookup failed:', err.message);
  }

  // Last resort: the built-in list, a different one each day.
  const bank = LIVE_TOPIC_META[TRENDING_GAME_TYPE].fallbacks;
  const dayNumber = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / DAY_MS);
  return {
    statement: cleanStatement(bank[((dayNumber % bank.length) + bank.length) % bank.length]),
    category: TRENDING_GAME_TYPE,
    sourceQuestionId: null,
    debateCount: 0
  };
}

// ── Topic ──────────────────────────────────────────────────────────────────

let topicCache = { key: null, at: 0, topic: null };

function countsFromData(data) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const agree = n(data && data.agreeCount);
  const disagree = n(data && data.disagreeCount);
  const noStance = n(data && data.noStanceCount);
  return { agree, disagree, noStance, total: agree + disagree + noStance };
}

/**
 * Today's topic, creating it from the fallback if nobody scheduled one.
 * Safe across instances: `create()` lets exactly one writer win, and the
 * losers re-read the winner's doc.
 */
async function getTodayTopic(now = Date.now()) {
  const cfg = (await loadSocialConfig()).dailyTopic;
  const date = new Date(now);
  const key = dayKeyInZone(cfg.timezone, date);
  const endsAt = nextMidnightMsInZone(cfg.timezone, date);

  if (topicCache.key === key && Date.now() - topicCache.at < TOPIC_CACHE_MS) {
    return { ...topicCache.topic, endsAt };
  }

  const db = requireDb();
  const ref = db.collection(COLLECTION).doc(key);
  let snap = await ref.get();

  if (!snap.exists || !cleanStatement(snap.data().statement)) {
    const admin = getAdmin();
    const picked = await pickFallbackTopic(db, cfg, key, now);
    const fields = {
      id: key,
      statement: picked.statement,
      category: picked.category,
      activeDate: key,
      source: 'fallback',
      sourceQuestionId: picked.sourceQuestionId
    };
    try {
      if (snap.exists) {
        await ref.set(fields, { merge: true });
      } else {
        await ref.create({
          ...fields,
          agreeCount: 0,
          disagreeCount: 0,
          noStanceCount: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      console.log(
        `[dailyTopic] ${key} had no scheduled topic — using fallback (debated ${picked.debateCount}x): "${picked.statement.slice(0, 80)}"`
      );
    } catch (err) {
      if (err.code !== GRPC_ALREADY_EXISTS) throw err;
    }
    snap = await ref.get();
  }

  const data = snap.data() || {};
  const topic = {
    id: key,
    statement: cleanStatement(data.statement),
    category: normalizeCategory(data.category),
    activeDate: key
  };
  topicCache = { key, at: Date.now(), topic };
  return { ...topic, endsAt };
}

// ── Counts ─────────────────────────────────────────────────────────────────

const countsCache = new Map(); // topicId → { at, counts }

async function getCounts(topicId, { fresh = false } = {}) {
  const cached = countsCache.get(topicId);
  if (!fresh && cached && Date.now() - cached.at < COUNTS_CACHE_MS) return cached.counts;
  const snap = await requireDb().collection(COLLECTION).doc(topicId).get();
  const counts = countsFromData(snap.exists ? snap.data() : null);
  countsCache.clear(); // only ever one live topic; don't accumulate old days
  countsCache.set(topicId, { at: Date.now(), counts });
  return counts;
}

const pendingBroadcast = new Map(); // topicId → timer

// Coalesces a burst of votes into one push per `countsBroadcastMs`.
function scheduleCountsBroadcast(io, topicId, delayMs) {
  if (!io || pendingBroadcast.has(topicId)) return;
  const timer = setTimeout(async () => {
    pendingBroadcast.delete(topicId);
    try {
      const counts = await getCounts(topicId, { fresh: true });
      io.to(votersRoom(topicId)).emit('dailyTopicCounts', { topicId, counts });
    } catch (err) {
      console.error('[dailyTopic] counts broadcast failed:', err.message);
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  pendingBroadcast.set(topicId, timer);
}

// ── Streak ─────────────────────────────────────────────────────────────────

// Streak after a first vote on `topicId`'s day.
function streakAfterVote(userData, topicId) {
  const last = userData && typeof userData.lastVoteDate === 'string' ? userData.lastVoteDate : null;
  const current = userData && Number.isFinite(userData.voteStreak) && userData.voteStreak > 0
    ? Math.floor(userData.voteStreak)
    : 0;
  if (last === topicId) return Math.max(current, 1);
  if (last === shiftDayKey(topicId, -1)) return current + 1;
  return 1;
}

// Streak to show right now: still alive if the last vote was today or
// yesterday (today's vote can still extend it), otherwise broken.
function currentStreak(userData, todayKey) {
  const last = userData && typeof userData.lastVoteDate === 'string' ? userData.lastVoteDate : null;
  const current = userData && Number.isFinite(userData.voteStreak) && userData.voteStreak > 0
    ? Math.floor(userData.voteStreak)
    : 0;
  return last === todayKey || last === shiftDayKey(todayKey, -1) ? current : 0;
}

// ── Voting ─────────────────────────────────────────────────────────────────

function votePayload(stance, changeCount, maxVoteChanges) {
  return {
    stance,
    changeCount,
    changesLeft: Math.max(0, maxVoteChanges - changeCount)
  };
}

/**
 * Cast (`change: false`) or change (`change: true`) a user's vote on today's
 * topic.
 *
 *   cast   — rejected with `already_voted` if the user has a vote
 *   change — rejected with `not_voted` if they don't, and with
 *            `change_limit` once they've used `maxVoteChanges`
 *
 * Returns { ok, error?, topicId, vote, streak? }. `vote` is the user's vote
 * as it stands after the call, including on a rejection.
 */
async function castVote({ userId, stance, change = false, topicId = null, now = Date.now() }) {
  if (!STANCES.includes(stance)) return { ok: false, error: 'invalid_stance' };

  const cfg = (await loadSocialConfig()).dailyTopic;
  const topic = await getTodayTopic(now);
  // The client names the topic it is looking at, so a vote sent just after
  // midnight can't land on a topic the user has never seen.
  if (topicId && topicId !== topic.id) return { ok: false, error: 'topic_changed', topicId: topic.id };

  const db = requireDb();
  const admin = getAdmin();
  const FieldValue = admin.firestore.FieldValue;
  const topicRef = db.collection(COLLECTION).doc(topic.id);
  const voteRef = topicRef.collection('votes').doc(userId);
  const userRef = db.collection('users').doc(userId);

  const result = await db.runTransaction(async (tx) => {
    const voteSnap = await tx.get(voteRef);

    if (!voteSnap.exists) {
      if (change) return { ok: false, error: 'not_voted', vote: null };
      const userSnap = await tx.get(userRef);
      const streak = userSnap.exists ? streakAfterVote(userSnap.data(), topic.id) : 1;

      tx.create(voteRef, {
        topicId: topic.id,
        userId,
        stance,
        changeCount: 0,
        updatedAt: FieldValue.serverTimestamp()
      });
      tx.update(topicRef, { [COUNT_FIELD[stance]]: FieldValue.increment(1) });
      // Never create a bare users doc for an id that has no account.
      if (userSnap.exists) {
        tx.update(userRef, { voteStreak: streak, lastVoteDate: topic.id });
      }
      return { ok: true, vote: votePayload(stance, 0, cfg.maxVoteChanges), streak };
    }

    const prev = voteSnap.data() || {};
    const prevStance = STANCES.includes(prev.stance) ? prev.stance : null;
    const changeCount = Number.isFinite(prev.changeCount) ? prev.changeCount : 0;
    const standing = votePayload(prevStance, changeCount, cfg.maxVoteChanges);

    if (!change) return { ok: false, error: 'already_voted', vote: standing };
    if (prevStance === stance) return { ok: true, vote: standing };
    if (changeCount >= cfg.maxVoteChanges) return { ok: false, error: 'change_limit', vote: standing };

    tx.update(voteRef, {
      stance,
      changeCount: changeCount + 1,
      updatedAt: FieldValue.serverTimestamp()
    });
    const counters = { [COUNT_FIELD[stance]]: FieldValue.increment(1) };
    if (prevStance) counters[COUNT_FIELD[prevStance]] = FieldValue.increment(-1);
    tx.update(topicRef, counters);
    return { ok: true, vote: votePayload(stance, changeCount + 1, cfg.maxVoteChanges) };
  });

  return { ...result, topicId: topic.id };
}

async function getVote(topicId, userId, maxVoteChanges) {
  const snap = await requireDb().collection(COLLECTION).doc(topicId).collection('votes').doc(userId).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  if (!STANCES.includes(d.stance)) return null;
  return votePayload(d.stance, Number.isFinite(d.changeCount) ? d.changeCount : 0, maxVoteChanges);
}

// The side a user currently holds on a topic, or null if they haven't voted.
async function getStance(topicId, userId) {
  const vote = await getVote(topicId, userId, 0);
  return vote ? vote.stance : null;
}

// One vote request per user per `voteCooldownMs`, across every socket and
// instance. Redis trouble fails open: the transaction above is what
// guarantees one vote per user, this only stops hammering.
async function passesCooldown(userId, cooldownMs) {
  if (!cooldownMs) return true;
  try {
    const set = await redis.set(`dailyTopic:voteCooldown:${userId}`, '1', 'PX', Math.ceil(cooldownMs), 'NX');
    return set === 'OK';
  } catch (err) {
    console.warn('[dailyTopic] cooldown check failed (allowing):', err.message);
    return true;
  }
}

// ── Socket handlers ────────────────────────────────────────────────────────

async function enterVotersRoom(socket, topicId) {
  const room = votersRoom(topicId);
  const previous = socket.data.dailyTopicRoom;
  if (previous && previous !== room) {
    await socket.leave(previous);
  }
  await socket.join(room);
  socket.data.dailyTopicRoom = room;
}

async function leaveVotersRoom(socket) {
  const previous = socket.data.dailyTopicRoom;
  if (!previous) return;
  await socket.leave(previous);
  socket.data.dailyTopicRoom = null;
}

function publicError(err) {
  return err && err.code === 'unavailable' ? 'unavailable' : 'internal';
}

/**
 * Registers the daily-topic events on one socket.
 * `opts.now` lets tests pin the clock.
 */
function registerHandlers(io, socket, userId, opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;

  // (payload?, ack) → { payload, reply }. Events without an ack get a no-op.
  const unpack = (args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    const first = args[0];
    const raw = Array.isArray(first) ? first[0] : first;
    const payload = raw && typeof raw === 'object' ? raw : {};
    return { payload, reply: (body) => { if (ack) ack(body); } };
  };

  socket.on('dailyTopicState', async (...args) => {
    const { reply } = unpack(args);
    if (!socket.data.authenticated) return reply({ ok: false, error: 'auth_required' });
    try {
      const cfg = (await loadSocialConfig()).dailyTopic;
      const topic = await getTodayTopic(nowFn());
      const db = requireDb();
      const [vote, userSnap] = await Promise.all([
        getVote(topic.id, userId, cfg.maxVoteChanges),
        db.collection('users').doc(userId).get()
      ]);

      let counts = null;
      if (vote) {
        await enterVotersRoom(socket, topic.id);
        counts = await getCounts(topic.id);
      } else {
        await leaveVotersRoom(socket);
      }

      reply({
        ok: true,
        topic,
        vote,
        counts,
        streak: currentStreak(userSnap.exists ? userSnap.data() : null, topic.id),
        maxVoteChanges: cfg.maxVoteChanges,
        serverNow: Date.now()
      });
    } catch (err) {
      console.error('[dailyTopicState] failed:', err.message);
      reply({ ok: false, error: publicError(err) });
    }
  });

  socket.on('dailyTopicVote', async (...args) => {
    const { payload, reply } = unpack(args);
    if (!socket.data.authenticated) return reply({ ok: false, error: 'auth_required' });
    try {
      const cfg = (await loadSocialConfig()).dailyTopic;
      if (!STANCES.includes(payload.stance)) return reply({ ok: false, error: 'invalid_stance' });
      if (!(await passesCooldown(userId, cfg.voteCooldownMs))) {
        return reply({ ok: false, error: 'slow_down', retryAfterMs: cfg.voteCooldownMs });
      }

      const result = await castVote({
        userId,
        stance: payload.stance,
        change: payload.change === true,
        topicId: typeof payload.topicId === 'string' ? payload.topicId : null,
        now: nowFn()
      });

      // Whatever happened, a user who has a vote may see the counts.
      let counts = null;
      if (result.vote && result.topicId) {
        await enterVotersRoom(socket, result.topicId);
        counts = await getCounts(result.topicId, { fresh: result.ok });
        if (result.ok) scheduleCountsBroadcast(io, result.topicId, cfg.countsBroadcastMs);
      }

      console.log(
        `[dailyTopicVote] userId=${userId} topic=${result.topicId || '?'} stance=${payload.stance} change=${payload.change === true} → ${result.ok ? 'ok' : result.error}`
      );
      reply({ ...result, counts });
    } catch (err) {
      console.error('[dailyTopicVote] failed:', err.message);
      reply({ ok: false, error: publicError(err) });
    }
  });
}

function _resetForTests() {
  topicCache = { key: null, at: 0, topic: null };
  countsCache.clear();
  for (const timer of pendingBroadcast.values()) clearTimeout(timer);
  pendingBroadcast.clear();
}

module.exports = {
  COLLECTION,
  STANCES,
  votersRoom,
  getTodayTopic,
  getCounts,
  castVote,
  getStance,
  streakAfterVote,
  currentStreak,
  registerHandlers,
  _resetForTests
};
