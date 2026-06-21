// nextQuestion.js — returns the next unseen debate question for a user.
//
// GET /next-question?gameType=<type>
//   Authorization: Bearer <Firebase ID token>
//   -> { questionId, questionText, question, categoryId, topicTitle }
//
// Legacy GET /active-question redirects to the same handler.

const express = require('express');
const { getAuth } = require('./firestoreClient');
const { pickNextQuestionForUser } = require('./questionPicker');
const { recordQuestionShown } = require('./questionHistory');
const { LIVE_TOPIC_META, TRENDING_GAME_TYPE } = require('./topicDebate');

function formatResponse(q) {
  return {
    questionId: q.questionId,
    questionText: q.questionText,
    question: q.questionText,
    categoryId: q.categoryId,
    topicTitle: q.topicTitle
  };
}

async function resolveUserId(req) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const idToken = bearer || req.query.idToken || req.body?.idToken;
  if (!idToken) return null;
  try {
    const auth = getAuth();
    if (!auth) return null;
    const decoded = await auth.verifyIdToken(String(idToken));
    return decoded.uid;
  } catch (err) {
    console.warn('[next-question] token verify failed:', err.message);
    return null;
  }
}

function makeRouter() {
  const router = express.Router();

  async function handleNextQuestion(req, res) {
    const gameType = String(req.query.gameType || TRENDING_GAME_TYPE);

    if (gameType === 'custom') {
      return res.status(400).json({ error: 'custom debates do not use next-question' });
    }

    if (!LIVE_TOPIC_META[gameType]) {
      return res.status(400).json({ error: `Unknown gameType: ${gameType}` });
    }

    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const picked = await pickNextQuestionForUser(userId, gameType);
      recordQuestionShown(userId, picked.questionId).catch(() => {});
      console.log(`[next-question] serve user=${userId} category=${gameType} questionId=${picked.questionId}`);
      return res.json(formatResponse(picked));
    } catch (err) {
      console.error('[next-question] failed:', err.message);
      const meta = LIVE_TOPIC_META[gameType];
      const q = meta.fallbacks[0];
      return res.json({
        questionId: null,
        questionText: q,
        question: q,
        categoryId: gameType,
        topicTitle: meta.title
      });
    }
  }

  router.get('/next-question', handleNextQuestion);
  router.get('/active-question', handleNextQuestion);

  return router;
}

module.exports = { makeRouter };
