// judge.js — Express route that has Perplexity Sonar judge a finished debate.
//
// iOS POSTs the full transcript with player labels (X / O); we ask Sonar to
// evaluate argument quality + factual accuracy and return:
//   { winner: "X"|"O"|"tie", scoreX: 0-10, scoreO: 0-10, review: "...", sources: [] }
//
// Cross-instance single-flight (Redis):
//   Both players hit /judge ~simultaneously. Without coordination, two
//   instances would each call Perplexity (double cost) and produce two
//   different reviews (bad UX — the players see different verdicts).
//   The pattern below uses a Redis lock + result key:
//     1. GET judge:{gameId}        — cached? return it.
//     2. SET judge-lock:{gameId} NX EX 60 — got the lock? do the call,
//                                          write the result, release lock.
//     3. Lost the lock?            — poll judge:{gameId} until the leader
//                                    publishes (up to ~25s, well under
//                                    the iOS request timeout).

const express = require('express');
const store = require('./gameStore');

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';

function stanceDescription(position) {
  if (position === 'support') {
    return 'Support side — must argue IN FAVOR of the proposition implied by the debate question (affirmative / "yes" position).';
  }
  if (position === 'oppose') {
    return 'Oppose side — must argue AGAINST that proposition (negative / "no" position).';
  }
  return null;
}

function stanceShortLabel(position) {
  if (position === 'support') return 'Support';
  if (position === 'oppose') return 'Oppose';
  return null;
}

function buildSideInstructions(nameX, nameO, stances) {
  const xDesc = stanceDescription(stances && stances.X);
  const oDesc = stanceDescription(stances && stances.O);
  const hasSides = Boolean(xDesc || oDesc);

  if (!hasSides) {
    return `
SIDE ASSIGNMENTS
No Support/Oppose assignments were recorded for this debate. Score each player on argument quality and relevance to the debate question without requiring a specific pro/con stance.
`;
  }

  const lines = [
    '',
    'ASSIGNED SIDES (critical — grade against these roles)',
  ];
  if (xDesc) lines.push(`- ${nameX}: ${xDesc}`);
  if (oDesc) lines.push(`- ${nameO}: ${oDesc}`);
  lines.push(
    '',
    'When scoring WITH assigned sides:',
    '- Reward clear, relevant arguments that advance their ASSIGNED side with reasoning and evidence.',
    '- Penalize players who argue the wrong side — e.g. a Supporter arguing against the question, or an Opposer arguing in favor. Cap wrong-side players at 4 unless they also made substantial correct-side points.',
    '- Penalize ignoring the question entirely or only personal attacks (existing caps still apply).',
    '- Do NOT score based on whether you personally agree with their side — only on how well they argued the side they were assigned.',
  );
  return lines.join('\n');
}

function buildSystemPrompt(todayHuman, nameX, nameO, stances) {
  const sideBlock = buildSideInstructions(nameX, nameO, stances);

  return `You are an impartial AI debate judge. Two players just had a short debate: ${nameX} and ${nameO}. Today is ${todayHuman}. You have access to the live web — use it to spot-check any factual claims.
${sideBlock}

In your scoring output:
- "ScoreX" is ${nameX}'s score.
- "ScoreO" is ${nameO}'s score.
In your written review, refer to the players by name (${nameX} and ${nameO}). Do NOT call them "Player X", "Player O", "Player 1", or "Player 2".

YOUR TASK
1. Read the full transcript carefully.
2. Score each player independently from 0 to 10 using the scale below.
3. Write a 2-4 sentence review explaining the scores using the players' names. Quote or paraphrase the strongest specific argument from each side that actually contributed. If a player was silent or hostile, say so plainly. Do not share your personal opinion on the topic.

You do NOT pick the winner. The application code will compare the two scores numerically — your only job is to set them honestly.

SCORING SCALE (apply STRICTLY — do not inflate scores out of politeness)
- 0  = did not participate at all (no messages, or only whitespace).
- 1  = only sent gibberish, spam, or a single useless message.
- 2  = ONLY insults, profanity, slurs, hate speech, or trolling. No actual argument.
- 3  = weak, off-topic, or contradictory; almost no reasoning.
- 4  = touches the topic but argument is unclear, unsupported, OR mostly argues the wrong assigned side.
- 5-6 = average — makes relevant points on their assigned side but lacks evidence or depth.
- 7-8 = strong — clear reasoning on their assigned side plus at least one concrete example or piece of evidence; factually accurate.
- 9-10 = excellent — well-structured, persuasive on their assigned side, multiple specific points, factually verified, no falsehoods.

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

// How long the loser-of-the-lock will poll for the winner's published
// result before giving up. Total = POLL_INTERVAL_MS * MAX_POLLS. Keep
// comfortably under whatever timeout the iOS client uses for /judge.
const POLL_INTERVAL_MS = 500;
const MAX_POLLS = 50; // 25 seconds

async function waitForCachedResult(gameId) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const cached = await store.getJudgeResult(gameId);
    if (cached) return cached;
  }
  return null;
}

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  // Strip newlines so a name can't break out of the prompt structure, trim,
  // and cap length to a reasonable display size.
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);
  return cleaned.length > 0 ? cleaned : fallback;
}

function sanitizeStance(raw) {
  if (raw !== 'support' && raw !== 'oppose') return null;
  return raw;
}

async function resolvePlayerStances(gameId, clientStances) {
  const stances = { X: null, O: null };

  if (typeof gameId === 'string' && gameId.length > 0) {
    const state = await store.loadGameState(gameId);
    if (state) {
      stances.X = sanitizeStance(state.player1Position);
      stances.O = sanitizeStance(state.player2Position);
    }
  }

  if (clientStances && typeof clientStances === 'object') {
    if (!stances.X) stances.X = sanitizeStance(clientStances.X);
    if (!stances.O) stances.O = sanitizeStance(clientStances.O);
  }

  return stances;
}

async function callSonar(apiKey, topic, question, safeMessages, names, stances) {
  const nameX = names.X;
  const nameO = names.O;

  const transcript = safeMessages
    .map((m) => {
      const isO = m.player === 'O';
      const label = isO ? nameO : nameX;
      const side = isO ? stances.O : stances.X;
      const sideTag = stanceShortLabel(side);
      const prefix = sideTag ? `[${label} (${sideTag})]` : `[${label}]`;
      return `${prefix}: ${m.text.trim()}`;
    })
    .join('\n');

  const now = new Date();
  const todayHuman = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const sideSummary = (() => {
    const xLabel = stanceShortLabel(stances.X);
    const oLabel = stanceShortLabel(stances.O);
    if (!xLabel && !oLabel) return '';
    const parts = [];
    if (xLabel) parts.push(`${nameX} = ${xLabel}`);
    if (oLabel) parts.push(`${nameO} = ${oLabel}`);
    return `\nSide assignments: ${parts.join(', ')}.\n`;
  })();

  const userPrompt =
    `Topic: ${topic}\n` +
    `Debate Question: ${question}\n` +
    sideSummary +
    `\nThe two debaters are ${nameX} (their score = ScoreX) and ${nameO} (their score = ScoreO).\n\n` +
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
        { role: 'system', content: buildSystemPrompt(todayHuman, nameX, nameO, stances) },
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

    const {
      topic = '',
      question = '',
      messages = [],
      gameId = '',
      playerNames: rawNames = {},
      playerStances: rawStances = {},
    } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }

    const names = {
      X: sanitizeName(rawNames && rawNames.X, 'Player 1'),
      O: sanitizeName(rawNames && rawNames.O, 'Player 2'),
    };

    const stances = await resolvePlayerStances(gameId, rawStances);

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

    // No gameId? Fall back to per-call execution (no de-duplication
    // possible). This branch is mostly for safety — iOS always sends one.
    if (typeof gameId !== 'string' || gameId.length === 0) {
      try {
        const result = await callSonar(apiKey, topic, question, safeMessages, names, stances);
        return res.json(result);
      } catch (err) {
        const status = err.status && err.status >= 400 && err.status < 600 ? 502 : 500;
        console.error('[judge] error:', err.message);
        return res.status(status).json({ error: 'Judge failed' });
      }
    }

    // Step 1: cached?
    const cached = await store.getJudgeResult(gameId);
    if (cached) return res.json(cached);

    // Step 2: try to be the leader for this gameId.
    const gotLock = await store.tryAcquireJudgeLock(gameId);
    if (gotLock) {
      try {
        const result = await callSonar(apiKey, topic, question, safeMessages, names, stances);
        await store.setJudgeResult(gameId, result);
        return res.json(result);
      } catch (err) {
        const status = err.status && err.status >= 400 && err.status < 600 ? 502 : 500;
        console.error('[judge] error:', err.message);
        return res.status(status).json({ error: 'Judge failed' });
      } finally {
        // Release ASAP so a retry after a failure doesn't have to wait
        // out the lock TTL.
        await store.releaseJudgeLock(gameId);
      }
    }

    // Step 3: someone else is computing — wait for their result.
    const result = await waitForCachedResult(gameId);
    if (result) return res.json(result);

    console.warn(`[judge] timed out waiting for cached result for gameId=${gameId}`);
    return res.status(504).json({ error: 'Judge timed out' });
  });

  return router;
}

module.exports = { makeRouter };
