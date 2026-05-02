// judge.js — Express route that has Perplexity Sonar judge a finished debate.
//
// iOS POSTs the full transcript with player labels (X / O); we ask Sonar to
// evaluate argument quality + factual accuracy and return:
//   { winner: "X"|"O"|"tie", scoreX: 0-10, scoreO: 0-10, review: "...", sources: [] }

const express = require('express');

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';

function buildSystemPrompt(todayHuman) {
  return `You are an impartial AI debate judge. Two anonymous players (Player X and Player O) just had a short debate. Today is ${todayHuman}. You have access to the live web — use it to spot-check any factual claims.

YOUR TASK
1. Read the full transcript carefully.
2. Score each player from 0 to 10 based on:
   - Relevance to the debate question
   - Clarity and structure of reasoning
   - Quality of evidence and concrete examples
   - Factual accuracy — verify current-event claims against today's web sources; mark down false ones
   - Rhetorical effectiveness without being misleading or insulting
3. Pick a winner (X or O), or call it a tie if scores are within 1 point.
4. Write a concise 2-4 sentence review explaining the decision. Mention the strongest specific argument from each side. Do NOT reveal personal opinions on the topic.

BE FAIR
- Do not favor a side based on which view you personally agree with. Judge ONLY on argument quality and accuracy.
- A player who barely participated, only insulted, or repeated themselves loses points.
- Empty or near-empty transcripts: call it a tie with low scores.

Return EXACTLY this format (no markdown, no extra prose, no JSON):
Winner: <X|O|tie>
ScoreX: <integer 0-10>
ScoreO: <integer 0-10>
Review: <2-4 sentences>`;
}

function parseJudgeReply(content) {
  const lines = (content || '').split(/\r?\n/);
  const findLine = (prefix) =>
    (lines.find((l) => l.toLowerCase().trim().startsWith(prefix)) || '')
      .replace(new RegExp(`^${prefix}`, 'i'), '')
      .trim();

  const winnerRaw = findLine('winner:').toUpperCase();
  let winner = 'tie';
  if (winnerRaw === 'X' || winnerRaw === 'O') winner = winnerRaw;

  const parseScore = (raw) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 5;
    return Math.max(0, Math.min(10, n));
  };
  const scoreX = parseScore(findLine('scorex:'));
  const scoreO = parseScore(findLine('scoreo:'));
  const review = findLine('review:') || (content || '').trim();

  return { winner, scoreX, scoreO, review };
}

function makeRouter() {
  const router = express.Router();

  router.post('/judge', async (req, res) => {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfigured: PERPLEXITY_API_KEY not set' });
    }

    const { topic = '', question = '', messages = [] } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }

    // Cap to last N to keep token cost bounded.
    const MAX_MESSAGES = 80;
    const safeMessages = messages
      .filter((m) => m && typeof m.text === 'string' && m.text.trim().length > 0)
      .slice(-MAX_MESSAGES);

    if (safeMessages.length === 0) {
      return res.json({
        winner: 'tie',
        scoreX: 0,
        scoreO: 0,
        review: 'No messages were exchanged, so there is nothing to judge.',
        sources: [],
      });
    }

    const transcript = safeMessages
      .map((m) => {
        const label = m.player === 'O' ? 'O' : 'X';
        return `[Player ${label}]: ${m.text.trim()}`;
      })
      .join('\n');

    const now = new Date();
    const todayHuman = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const userPrompt =
      `Topic: ${topic}\n` +
      `Debate Question: ${question}\n\n` +
      `Transcript:\n${transcript}`;

    try {
      const upstream = await fetch(PERPLEXITY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          max_tokens: 500,
          search_recency_filter: 'month',
          messages: [
            { role: 'system', content: buildSystemPrompt(todayHuman) },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        console.error(`[judge] Perplexity ${upstream.status}: ${errText}`);
        return res.status(502).json({ error: 'Upstream judge service failed' });
      }

      const data = await upstream.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const sources = Array.isArray(data?.citations) ? data.citations : [];

      const parsed = parseJudgeReply(content);
      return res.json({ ...parsed, sources });
    } catch (err) {
      console.error('[judge] error:', err.message);
      return res.status(500).json({ error: 'Judge failed' });
    }
  });

  return router;
}

module.exports = { makeRouter };
