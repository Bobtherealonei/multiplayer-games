// questionHistory.js — per-user question exposure history in Firestore.
//
// users/{userId}/questionHistory/{questionId}
//   questionId, shownAt, position, matched, debated
//
// Used to avoid showing the same question twice in a session and to deprioritize
// recently debated prompts.

const { getDb, getAdmin } = require('./firestoreClient');

const RECENT_SHOWN_LIMIT = Number(process.env.QUESTION_HISTORY_LIMIT) || 50;
const DEBATED_COOLDOWN_MS =
  Number(process.env.QUESTION_DEBATED_COOLDOWN_MS) || 21 * 24 * 60 * 60 * 1000;

async function recordQuestionShown(userId, questionId, { position = null } = {}) {
  const db = getDb();
  if (!db || !userId || !questionId) return;
  const admin = getAdmin();
  const ref = db.collection('users').doc(userId).collection('questionHistory').doc(questionId);
  await ref.set(
    {
      questionId,
      shownAt: admin.firestore.FieldValue.serverTimestamp(),
      position: position || null,
      matched: false,
      debated: false
    },
    { merge: true }
  );
}

async function recordQuestionAnswered(userId, questionId, position) {
  const db = getDb();
  if (!db || !userId || !questionId) return;
  const admin = getAdmin();
  const ref = db.collection('users').doc(userId).collection('questionHistory').doc(questionId);
  await ref.set(
    {
      questionId,
      shownAt: admin.firestore.FieldValue.serverTimestamp(),
      position: position || null,
      matched: false,
      debated: false
    },
    { merge: true }
  );
}

async function markQuestionMatched(userId, questionId) {
  const db = getDb();
  if (!db || !userId || !questionId) return;
  await db
    .collection('users')
    .doc(userId)
    .collection('questionHistory')
    .doc(questionId)
    .set({ matched: true }, { merge: true });
}

async function markQuestionDebated(userId, questionId) {
  const db = getDb();
  if (!db || !userId || !questionId) return;
  const admin = getAdmin();
  await db
    .collection('users')
    .doc(userId)
    .collection('questionHistory')
    .doc(questionId)
    .set(
      {
        debated: true,
        debatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
}

/**
 * Returns question IDs this user should not be shown right now.
 * @param {string} userId
 * @param {object} opts
 * @param {Set<string>} opts.sessionExcluded - in-memory / Redis session set
 * @param {string[]} opts.queuedQuestionIds - questions already in queue
 */
async function getExcludedQuestionIds(userId, { sessionExcluded = new Set(), queuedQuestionIds = [] } = {}) {
  const excluded = new Set(sessionExcluded);
  for (const qid of queuedQuestionIds) {
    if (qid) excluded.add(String(qid));
  }

  const db = getDb();
  if (!db || !userId) return excluded;

  try {
    const snap = await db
      .collection('users')
      .doc(userId)
      .collection('questionHistory')
      .orderBy('shownAt', 'desc')
      .limit(RECENT_SHOWN_LIMIT)
      .get();

    const now = Date.now();
    snap.forEach((doc) => {
      excluded.add(doc.id);
      const data = doc.data();
      if (data.debated && data.debatedAt) {
        const debatedAt = data.debatedAt.toMillis?.() ?? data.debatedAt ?? 0;
        if (now - debatedAt < DEBATED_COOLDOWN_MS) {
          excluded.add(doc.id);
        }
      }
    });
  } catch (err) {
    console.warn('[questionHistory] getExcluded failed:', err.message);
  }

  return excluded;
}

module.exports = {
  RECENT_SHOWN_LIMIT,
  DEBATED_COOLDOWN_MS,
  recordQuestionShown,
  recordQuestionAnswered,
  markQuestionMatched,
  markQuestionDebated,
  getExcludedQuestionIds
};
