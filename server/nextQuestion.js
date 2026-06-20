// nextQuestion.js — returns the shared active debate question for a category.
//
// All users in the same category see the same question during the current
// rotation window. Questions are stored in Firestore (activeDebateQuestions)
// and rotated by the server every ~15 minutes.
//
// GET /active-question?gameType=<type>
//   -> { questionId, questionText, question, categoryId, topicTitle, startedAt, expiresAt }
//
// GET /next-question (legacy alias)

const express = require('express');
const { getActiveQuestion } = require('./activeDebateQuestion');
const { LIVE_TOPIC_META, TRENDING_GAME_TYPE } = require('./topicDebate');

function formatResponse(active) {
  return {
    questionId: active.questionId,
    questionText: active.questionText,
    question: active.questionText, // legacy field for iOS
    categoryId: active.categoryId,
    topicTitle: active.topicTitle,
    startedAt: active.startedAt,
    expiresAt: active.expiresAt
  };
}

function makeRouter() {
  const router = express.Router();

  async function handleActiveQuestion(req, res) {
    const gameType = String(req.query.gameType || TRENDING_GAME_TYPE);

    if (gameType === 'custom') {
      return res.status(400).json({ error: 'custom debates do not use active questions' });
    }

    if (!LIVE_TOPIC_META[gameType]) {
      return res.status(400).json({ error: `Unknown gameType: ${gameType}` });
    }

    try {
      const active = await getActiveQuestion(gameType);
      console.log(`[active-question] serve category=${gameType} questionId=${active.questionId}`);
      return res.json(formatResponse(active));
    } catch (err) {
      console.error('[active-question] failed:', err.message);
      const meta = LIVE_TOPIC_META[gameType];
      const q = meta.fallbacks[0];
      return res.json({
        questionId: null,
        questionText: q,
        question: q,
        categoryId: gameType,
        topicTitle: meta.title,
        startedAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000
      });
    }
  }

  router.get('/active-question', handleActiveQuestion);
  router.get('/next-question', handleActiveQuestion);

  return router;
}

module.exports = { makeRouter };
