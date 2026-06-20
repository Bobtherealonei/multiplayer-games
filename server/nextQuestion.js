// nextQuestion.js — Express route that hands the iOS client a single debate
// question BEFORE matchmaking, so the user can pick Support / Oppose / Skip.
//
// The question is chosen server-side (reusing the same live-news pool + the
// per-user "seen" dedup as the in-game resolver) so the client can't fabricate
// a questionId, and so two players who later match on the same questionId are
// guaranteed to have been offered the same real question.
//
// GET /next-question?gameType=<type>&userId=<uid>
//   -> { questionId, question, topicTitle }

const express = require('express');
const {
  pickTrendingQuestion,
  LIVE_TOPIC_META,
  TRENDING_GAME_TYPE
} = require('./topicDebate');

function makeRouter() {
  const router = express.Router();

  router.get('/next-question', async (req, res) => {
    const gameType = String(req.query.gameType || TRENDING_GAME_TYPE);
    const userId = req.query.userId ? String(req.query.userId) : null;

    if (gameType === 'custom') {
      return res.status(400).json({ error: 'custom debates do not use /next-question' });
    }

    const meta = LIVE_TOPIC_META[gameType];
    if (!meta) {
      return res.status(400).json({ error: `Unknown gameType: ${gameType}` });
    }

    try {
      const chosen = await pickTrendingQuestion(userId ? [userId] : [], gameType);
      return res.json({
        questionId: chosen.questionId,
        question: chosen.question,
        topicTitle: chosen.topicTitle
      });
    } catch (err) {
      console.error('[next-question] failed:', err.message);
      // Never leave the client without a question — serve a fallback.
      const bank = meta.fallbacks;
      return res.json({
        questionId: null,
        question: bank[Math.floor(Math.random() * bank.length)],
        topicTitle: meta.title
      });
    }
  });

  return router;
}

module.exports = { makeRouter };
