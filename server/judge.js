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
2. Score each player independently from 0 to 10 using the scale below.
3. Write a 2-4 sentence review explaining the scores. Quote or paraphrase the strongest specific argument from each side that actually contributed. If a player was silent or hostile, say so plainly. Do not share your personal opinion on the topic.

You do NOT pick the winner. The application code will compare the two scores numerically — your only job is to set them honestly.

SCORING SCALE (apply STRICTLY — do not inflate scores out of politeness)
- 0  = did not participate at all (no messages, or only whitespace).
- 1  = only sent gibberish, spam, or a single useless message.
- 2  = ONLY insults, profanity, slurs, hate speech, or trolling. No actual argument.
- 3  = weak, off-topic, or contradictory; almost no reasoning.
- 4  = touches the topic but argument is unclear or unsupported.
- 5-6 = average — makes a relevant point but lacks evidence or depth.
- 7-8 = strong — clear reasoning plus at least one concrete example or piece of evidence; factually accurate.
- 9-10 = excellent — well-structured, persuasive, multiple specific points, factually verified, no falsehoods.

ANY of these caps a player at 2 OR LOWER, regardless of length:
- Insults, profanity, slurs, or hate speech with no actual argument.
- Personal attacks instead of addressing the question.
- Pure trolling / off-topic spam.
- Made significant factually false claims that current web sources contradict.

DO NOT
- Do not adjust scores so they come out equal or unequal — score each player on their own merits, ignoring what the other got.
- Do not score insults or trolling as if they were arguments.
- Do not soften the score of a hostile or silent player. Reflect what actually happened.
- Do not write "winner" or "tie" anywhere in your output. The code decides that.

Return EXACTLY this format (no markdown, no extra prose, no JSON):
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

  const parseScore = (raw) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 5;
    return Math.max(0, Math.min(10, n));
  };
  const scoreX = parseScore(findLine('scorex:'));
  const scoreO = parseScore(findLine('scoreo:'));
  const review = findLine('review:') || (content || '').trim();

  // Winner is computed from the scores deterministically — the model is not
  // allowed to decide it. Pure number comparison: higher score wins, equal = tie.
  let winner;
  if (scoreX > scoreO) winner = 'X';
  else if (scoreO > scoreX) winner = 'O';
  else winner = 'tie';

  return { winner, scoreX, scoreO, review };
}

// In-memory cache: gameId -> { promise: Promise<result>, expiresAt: number }.
// Both players in a debate POST /judge with the same gameId; the first caller
// kicks off the Sonar request, the second caller awaits the same Promise — so
// both players see the identical verdict and Sonar is only charged once.
const judgeCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;     // 10 minutes
const MAX_CACHE_ENTRIES = 500;           // safety cap

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of judgeCache) {
    if (entry.expiresAt <= now) judgeCache.delete(key);
  }
  // Hard cap (drop oldest by insertion order — Map preserves order).
  while (judgeCache.size > MAX_CACHE_ENTRIES) {
    const oldest = judgeCache.keys().next().value;
    judgeCache.delete(oldest);
  }
}

async function callSonar(apiKey, topic, question, safeMessages) {
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
    const err = new Error(`Perplexity ${upstream.status}: ${errText}`);
    err.status = upstream.status;
    throw err;
  }

  const data = await upstream.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const sources = Array.isArray(data?.citations) ? data.citations : [];

  const parsed = parseJudgeReply(content);
  return { ...parsed, sources };
}

function makeRouter() {
  const router = express.Router();

  router.post('/judge', async (req, res) => {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfigured: PERPLEXITY_API_KEY not set' });
    }

    const { topic = '', question = '', messages = [], gameId = '' } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }

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

    pruneCache();

    // If a gameId is provided and we already have an in-flight or completed
    // promise for it, return its result so both players see the same verdict.
    if (typeof gameId === 'string' && gameId.length > 0) {
      const cached = judgeCache.get(gameId);
      if (cached && cached.expiresAt > Date.now()) {
        try {
          const result = await cached.promise;
          return res.json(result);
        } catch (err) {
          // Fall through and try a fresh Sonar call below.
          console.error('[judge] cached promise failed, retrying:', err.message);
          judgeCache.delete(gameId);
        }
      }
    }

    const promise = callSonar(apiKey, topic, question, safeMessages);

    if (typeof gameId === 'string' && gameId.length > 0) {
      judgeCache.set(gameId, { promise, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    try {
      const result = await promise;
      return res.json(result);
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? 502 : 500;
      console.error('[judge] error:', err.message);
      // Drop the failed cache entry so the next caller can retry.
      if (gameId) judgeCache.delete(gameId);
      return res.status(status).json({ error: 'Judge failed' });
    }
  });

  return router;
}

module.exports = { makeRouter };
