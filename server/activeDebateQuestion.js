// activeDebateQuestion.js — one shared active debate question per category
// (gameType), stored in Firestore so every user sees the same prompt during
// the same rotation window.
//
// Firestore: activeDebateQuestions/{gameType}
//   questionId, questionText, categoryId, topicTitle, startedAt, expiresAt
//
// Rotates every ACTIVE_QUESTION_MS (default 15 min). Users already queued on
// an older questionId keep their Redis queue entries and can still match each
// other; new entrants always receive the current active question.

const cron = require('node-cron');
const { getDb, getAdmin } = require('./firestoreClient');
const { pickTrendingQuestion, LIVE_TOPIC_META, TRENDING_GAME_TYPE } = require('./topicDebate');

const COLLECTION = 'activeDebateQuestions';
const ACTIVE_QUESTION_MS = Number(process.env.ACTIVE_QUESTION_MS) || 15 * 60 * 1000;

// Topic debate categories (not custom).
const ROTATING_GAME_TYPES = Object.keys(LIVE_TOPIC_META).filter((t) => t !== 'custom');

function stableFallbackId(gameType, questionText) {
  let h = 0;
  const s = `${gameType}:${questionText}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `fallback-${gameType}-${Math.abs(h)}`;
}

function normalizeDoc(data) {
  if (!data) return null;
  const startedAt = data.startedAt?.toMillis?.() ?? data.startedAt ?? null;
  const expiresAt = data.expiresAt?.toMillis?.() ?? data.expiresAt ?? null;
  return {
    questionId: data.questionId ?? null,
    questionText: data.questionText || data.question || '',
    categoryId: data.categoryId || data.gameType || null,
    topicTitle: data.topicTitle || null,
    startedAt,
    expiresAt
  };
}

function isStillActive(doc, now = Date.now()) {
  if (!doc) return false;
  if (!doc.expiresAt) return true;
  return doc.expiresAt > now;
}

async function pickQuestionForRotation(gameType, previousQuestionId = null) {
  const chosen = await pickTrendingQuestion([], gameType);
  let questionId = chosen.questionId;
  if (!questionId) {
    questionId = stableFallbackId(gameType, chosen.question);
  }
  // Avoid immediate repeat when the pool is small.
  if (previousQuestionId && questionId === previousQuestionId) {
    const meta = LIVE_TOPIC_META[gameType] || LIVE_TOPIC_META[TRENDING_GAME_TYPE];
    const bank = meta.fallbacks || [];
    const alt = bank.find((q) => stableFallbackId(gameType, q) !== previousQuestionId) || bank[0];
    if (alt) {
      return {
        questionId: stableFallbackId(gameType, alt),
        questionText: alt,
        topicTitle: meta.title
      };
    }
  }
  return {
    questionId,
    questionText: chosen.question,
    topicTitle: chosen.topicTitle
  };
}

async function rotateQuestion(gameType, { force = false } = {}) {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');

  const admin = getAdmin();
  const FieldValue = admin.firestore.FieldValue;
  const ref = db.collection(COLLECTION).doc(gameType);
  const now = Date.now();

  const snap = await ref.get();
  const existing = snap.exists ? normalizeDoc(snap.data()) : null;
  if (!force && isStillActive(existing, now)) {
    return existing;
  }

  const previousQuestionId = existing?.questionId ?? null;
  const picked = await pickQuestionForRotation(gameType, previousQuestionId);
  const payload = {
    questionId: picked.questionId,
    questionText: picked.questionText,
    categoryId: gameType,
    topicTitle: picked.topicTitle,
    startedAt: FieldValue.serverTimestamp(),
    expiresAt: now + ACTIVE_QUESTION_MS
  };
  await ref.set(payload);

  const out = normalizeDoc({ ...payload, startedAt: now });
  console.log(
    `[activeQuestion] rotated category=${gameType} questionId=${out.questionId} expiresIn=${Math.round(ACTIVE_QUESTION_MS / 60000)}m text="${out.questionText.slice(0, 80)}"`
  );
  return out;
}

async function getActiveQuestion(gameType) {
  const db = getDb();
  if (!db) {
    const meta = LIVE_TOPIC_META[gameType] || LIVE_TOPIC_META[TRENDING_GAME_TYPE];
    const q = meta.fallbacks[0];
    return {
      questionId: stableFallbackId(gameType, q),
      questionText: q,
      categoryId: gameType,
      topicTitle: meta.title,
      startedAt: Date.now(),
      expiresAt: Date.now() + ACTIVE_QUESTION_MS
    };
  }

  const ref = db.collection(COLLECTION).doc(gameType);
  const snap = await ref.get();
  const existing = snap.exists ? normalizeDoc(snap.data()) : null;
  if (isStillActive(existing)) {
    return existing;
  }
  return rotateQuestion(gameType);
}

async function ensureAllActiveQuestions() {
  for (const gameType of ROTATING_GAME_TYPES) {
    try {
      await getActiveQuestion(gameType);
    } catch (err) {
      console.error(`[activeQuestion] ensure failed for ${gameType}:`, err.message);
    }
  }
}

function scheduleActiveQuestionRotation() {
  ensureAllActiveQuestions();

  // Rotate every 15 minutes (all categories).
  cron.schedule('*/15 * * * *', () => {
    for (const gameType of ROTATING_GAME_TYPES) {
      rotateQuestion(gameType, { force: true }).catch((err) => {
        console.error(`[activeQuestion] cron rotate failed ${gameType}:`, err.message);
      });
    }
  });

  console.log(`[activeQuestion] rotation scheduled every ${Math.round(ACTIVE_QUESTION_MS / 60000)} min for: ${ROTATING_GAME_TYPES.join(', ')}`);
}

module.exports = {
  COLLECTION,
  ACTIVE_QUESTION_MS,
  ROTATING_GAME_TYPES,
  getActiveQuestion,
  rotateQuestion,
  ensureAllActiveQuestions,
  scheduleActiveQuestionRotation,
  normalizeDoc,
  isStillActive,
  stableFallbackId
};
