// questionPicker.js — pick the next unseen debate question for a user,
// preferring questions with waiting opponents and manageable balance.

const { client } = require('./redisClient');
const { LIVE_TOPIC_META, TRENDING_GAME_TYPE, ensureFreshCache, trendingCaches } = require('./topicDebate');
const { getExcludedQuestionIds } = require('./questionHistory');
const store = require('./gameStore');

const IMBALANCE_PENALTY_THRESHOLD = 5;
const SESSION_TTL_SECONDS = 4 * 60 * 60;

function sessionKey(userId, gameType) {
  return `sessionShown:${userId}:${gameType}`;
}

async function addSessionShown(userId, gameType, questionId) {
  if (!userId || !questionId) return;
  const k = sessionKey(userId, gameType);
  await client.sadd(k, String(questionId));
  await client.expire(k, SESSION_TTL_SECONDS);
}

async function getSessionShown(userId, gameType) {
  if (!userId) return new Set();
  const members = await client.smembers(sessionKey(userId, gameType));
  return new Set(members || []);
}

function stableFallbackId(gameType, questionText) {
  let h = 0;
  const s = `${gameType}:${questionText}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `fallback-${gameType}-${Math.abs(h)}`;
}

function exactQueueKey(gameType, questionId, position) {
  return `${gameType}::q::${questionId}::${position}`;
}

async function getQueueCounts(gameType, questionId) {
  const supportKey = `queue:${exactQueueKey(gameType, questionId, 'support')}`;
  const opposeKey = `queue:${exactQueueKey(gameType, questionId, 'oppose')}`;
  const [supportCount, opposeCount] = await Promise.all([
    client.zcard(supportKey),
    client.zcard(opposeKey)
  ]);
  return { supportCount: Number(supportCount) || 0, opposeCount: Number(opposeCount) || 0 };
}

function scoreQuestion({ supportCount, opposeCount }) {
  let score = 0;
  if (supportCount > 0 && opposeCount > 0) score += 120;
  else if (supportCount > 0 || opposeCount > 0) score += 45;

  const imbalance = Math.abs(supportCount - opposeCount);
  if (imbalance >= IMBALANCE_PENALTY_THRESHOLD) score -= imbalance * 6;
  if (supportCount >= 6 && opposeCount === 0) score -= 60;
  if (opposeCount >= 6 && supportCount === 0) score -= 60;

  return score;
}

/**
 * Pick the best next question for a user in a category.
 */
async function pickNextQuestionForUser(userId, gameType) {
  const meta = LIVE_TOPIC_META[gameType] || LIVE_TOPIC_META[TRENDING_GAME_TYPE];
  await ensureFreshCache();

  const sessionExcluded = await getSessionShown(userId, gameType);
  const queuedQuestionIds = await store.getUserQueueQuestionIds(userId);
  const excluded = await getExcludedQuestionIds(userId, {
    sessionExcluded,
    queuedQuestionIds
  });

  const pool = (trendingCaches[meta.topic] || trendingCaches.trendingUSA).items;
  let candidates = pool.filter((item) => item.id && !excluded.has(item.id));

  if (!candidates.length && pool.length) {
    candidates = pool.filter((item) => !queuedQuestionIds.includes(item.id));
  }

  if (!candidates.length) {
    const fallbacks = meta.fallbacks || [];
    const unseenFallbacks = fallbacks.filter(
      (q) => !excluded.has(stableFallbackId(gameType, q))
    );
    const text =
      unseenFallbacks[Math.floor(Math.random() * unseenFallbacks.length)] ||
      fallbacks[Math.floor(Math.random() * fallbacks.length)];
    const questionId = stableFallbackId(gameType, text);
    await addSessionShown(userId, gameType, questionId);
    return {
      questionId,
      questionText: text,
      categoryId: gameType,
      topicTitle: meta.title
    };
  }

  const scored = await Promise.all(
    candidates.map(async (item) => {
      const counts = await getQueueCounts(gameType, item.id);
      return {
        item,
        score: scoreQuestion(counts),
        ...counts
      };
    })
  );

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0]?.score ?? 0;
  const topTier = scored.filter((s) => s.score >= topScore - 12);
  const pick = topTier[Math.floor(Math.random() * topTier.length)];

  await addSessionShown(userId, gameType, pick.item.id);

  return {
    questionId: pick.item.id,
    questionText: pick.item.question,
    categoryId: gameType,
    topicTitle: meta.title
  };
}

/**
 * Pick a question neither player has recently seen (union of exclusions).
 */
async function pickNextQuestionForPair(userIds, gameType) {
  const meta = LIVE_TOPIC_META[gameType] || LIVE_TOPIC_META[TRENDING_GAME_TYPE];
  await ensureFreshCache();

  const excluded = new Set();
  for (const uid of userIds) {
    if (!uid) continue;
    const sessionExcluded = await getSessionShown(uid, gameType);
    const userExcluded = await getExcludedQuestionIds(uid, { sessionExcluded, queuedQuestionIds: [] });
    userExcluded.forEach((id) => excluded.add(id));
  }

  const pool = (trendingCaches[meta.topic] || trendingCaches.trendingUSA).items;
  let candidates = pool.filter((item) => item.id && !excluded.has(item.id));
  if (!candidates.length && pool.length) {
    candidates = pool.slice();
  }

  if (!candidates.length) {
    const fallbacks = meta.fallbacks || [];
    const unseenFallbacks = fallbacks.filter((q) => !excluded.has(stableFallbackId(gameType, q)));
    const text =
      unseenFallbacks[Math.floor(Math.random() * unseenFallbacks.length)] ||
      fallbacks[Math.floor(Math.random() * fallbacks.length)];
    const questionId = stableFallbackId(gameType, text);
    for (const uid of userIds) {
      if (uid) await addSessionShown(uid, gameType, questionId);
    }
    return {
      questionId,
      questionText: text,
      categoryId: gameType,
      topicTitle: meta.title
    };
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  for (const uid of userIds) {
    if (uid) await addSessionShown(uid, gameType, pick.id);
  }
  return {
    questionId: pick.id,
    questionText: pick.question,
    categoryId: gameType,
    topicTitle: meta.title
  };
}

module.exports = {
  pickNextQuestionForUser,
  pickNextQuestionForPair,
  addSessionShown,
  getSessionShown,
  stableFallbackId,
  exactQueueKey,
  getQueueCounts
};
