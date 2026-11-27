// dailyTopic.js — which topic the daily live debate is about.
//
// One topic per day. The day rolls over at local midnight in the configured
// timezone (siteSettings/social → dailyTopic.timezone, US Central by default).
//
//   dailyTopics/{YYYY-MM-DD}
//     id, statement, category, activeDate, supportCount, opposeCount,
//     messageCount, source ('admin' | 'fallback'), createdAt
//
// The doc id IS the active date, so there can only be one topic per day. An
// admin schedules a topic by saving the doc for a date ahead of time (the
// in-app scheduler or the admin site); if no doc exists when the day starts,
// the most-debated question of the last few days is used instead, so the
// live debate is never empty.
//
// Sides, messages and the live counts are in social/live.js.

const { getDb, getAdmin } = require('./firestoreClient');
const { loadSocialConfig } = require('./socialConfig');
const { dayKeyInZone, nextMidnightMsInZone, shiftDayKey } = require('./timeUtil');
const { pickTrendingQuestion, LIVE_TOPIC_META, TRENDING_GAME_TYPE } = require('./topicDebate');

const COLLECTION = 'dailyTopics';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOPIC_CACHE_MS = 15 * 1000;
// Debates scanned to find the most-debated topic (once per day, at most).
const FALLBACK_SCAN_LIMIT = 500;
// A fallback never repeats a statement used as the daily topic this recently.
const NO_REPEAT_DAYS = 7;
const MAX_STATEMENT_LENGTH = 300;
const GRPC_ALREADY_EXISTS = 6;

const CATEGORY_KEYS = Object.keys(LIVE_TOPIC_META).filter((k) => k !== 'custom');

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

// The clock the topic day is read from. Tests move it to a day of their
// own so they never touch the real topic.
let clock = () => Date.now();

function _setClockForTests(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
  topicCache = { key: null, at: 0, topic: null };
}

/** The day key (YYYY-MM-DD) and the moment that day ends, in the topic timezone. */
async function today(now = clock()) {
  const cfg = (await loadSocialConfig()).dailyTopic;
  const date = new Date(now);
  return {
    key: dayKeyInZone(cfg.timezone, date),
    endsAt: nextMidnightMsInZone(cfg.timezone, date),
    timezone: cfg.timezone
  };
}

/**
 * Today's topic, creating it from the fallback if nobody scheduled one.
 * Safe across instances: `create()` lets exactly one writer win, and the
 * losers re-read the winner's doc.
 * Returns { id, statement, category, activeDate, endsAt }.
 */
async function getTodayTopic(now = clock()) {
  const cfg = (await loadSocialConfig()).dailyTopic;
  const { key, endsAt } = await today(now);

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
          supportCount: 0,
          opposeCount: 0,
          messageCount: 0,
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

// An admin edited or scheduled a topic: don't keep serving the cached one.
function forgetTopicCache() {
  topicCache = { key: null, at: 0, topic: null };
}

module.exports = {
  COLLECTION,
  CATEGORY_KEYS,
  MAX_STATEMENT_LENGTH,
  cleanStatement,
  normalizeCategory,
  today,
  getTodayTopic,
  forgetTopicCache,
  _setClockForTests
};
