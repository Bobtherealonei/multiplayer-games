// judge.js — Express route that judges a finished debate with a hybrid
// two-engine strategy:
//
//   'walkover' — no API call at all. A player who never sent a substantive
//                message loses to one who did; two silent players tie.
//   'standard' — gpt-4o-mini scores argument quality from the transcript
//                alone (~$0.001/debate). Used for pure-opinion debates.
//   'verified' — Perplexity Sonar scores WITH live web search
//                (~$0.006-0.01/debate). Used when the transcript contains
//                factual / current-events claims worth checking.
//
// Which engine runs is decided by judgePolicy.decideJudgeMode() from the
// game's category, philosopher flag, pre-verified ammo, and a factual-claim
// scan of the transcript. Either engine returns the same shape:
//   { winner: "X"|"O"|"tie", scoreX: 0-10, scoreO: 0-10, review: "...",
//     sources: [], judgeMode: "walkover"|"standard"|"verified" }
//
// Cross-instance single-flight (Redis):
//   Both players hit /judge ~simultaneously. Without coordination, two
//   instances would each call the API (double cost) and produce two
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
const { getDb } = require('./firestoreClient');
const {
  AI_OPPONENT_ID,
  isSubstantiveText,
  participationBySymbol,
  decideJudgeMode,
  wantsRecencyFilter,
} = require('./judgePolicy');

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// One judge call per debate decides who wins trophies — worth a full-size
// model (~$0.004/debate on gpt-4.1 vs ~$0.0003 on gpt-4o-mini). The mini
// model over-rewarded whichever side quoted more facts, which in AI games
// is always the AI (it is handed news facts every turn).
const OPENAI_MODEL = 'gpt-4.1';

// Scores + a 2-4 sentence review fit comfortably in 300 tokens; the old 500
// cap just paid for prose nobody reads.
const JUDGE_MAX_TOKENS = 520;

function stanceDescription(position) {
  if (position === 'support') {
    return 'Support side — must argue IN FAVOR of the debate statement (agrees with the proposition).';
  }
  if (position === 'oppose') {
    return 'Oppose side — must argue AGAINST the debate statement (disagrees with the proposition).';
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
    'SIDE-FIDELITY CHECK (do this FIRST, for each player separately):',
    'Before scoring quality, decide for each player whether their arguments actually defend their ASSIGNED side above.',
    '- Argued their assigned side: score normally on the quality scale.',
    '- Mostly argued the OPPOSITE of their assigned side (e.g. a Supporter attacking the statement, or an Opposer defending it): cap that player at 1, no matter how well-written their points are — they contributed nothing to the case they were given. Say so in the review.',
    '- Mixed (some correct-side points, some wrong-side): score only the correct-side contributions and deduct 1-2 points for the confusion.',
    '- Merely QUOTING or rebutting the opponent\'s side does not count as arguing the wrong side — only their own affirmative case matters.',
    '- A player who made at least ONE relevant argument for their ASSIGNED side scores at least 3, even if it was brief, unpolished, or unsupported. A wrong-side-capped player can therefore never outscore an opponent who argued their own side at all.',
    '',
    'Also when scoring:',
    '- Reward clear, relevant arguments that advance their ASSIGNED side with reasoning, examples, and evidence.',
    '- Penalize ignoring the question entirely or only personal attacks (existing caps still apply).',
    '- Do NOT score based on whether you personally agree with their side — only on how well they argued the side they were assigned.',
  );
  return lines.join('\n');
}

// hasWeb toggles the fact-checking framing: the Sonar prompt tells the model
// to verify claims against live sources; the mini prompt tells it to judge
// reasoning and only penalize claims that are false per common knowledge —
// never to guess about very recent events it can't check.
function buildSystemPrompt(todayHuman, nameX, nameO, stances, hasWeb) {
  const sideBlock = buildSideInstructions(nameX, nameO, stances);

  const factLine = hasWeb
    ? 'You have access to the live web. Use it ONLY to check specific factual claims a player actually made (a number, a date, an event, a law). Do NOT research the debate topic itself, and never give a player credit because your research agrees with their side — that is taking sides, which is forbidden.'
    : 'You do NOT have web access. Judge argument quality, clarity, relevance, and reasoning. Penalize claims that are clearly false by well-established common knowledge, but do NOT guess about very recent events you cannot verify — score those on reasoning alone.';

  const falseClaimCap = hasWeb
    ? '- Made significant factually false claims that current web sources contradict.'
    : '- Made significant claims that are clearly false by well-established common knowledge.';

  return `You are an impartial AI debate judge. Two players just had a short debate: ${nameX} and ${nameO}. Today is ${todayHuman}. ${factLine}
${sideBlock}

FORMAT OF THIS DEBATE
- Players alternate turns. Each turn is a chat message typed under a clock of roughly 45 seconds, so messages are short (often one or two sentences).
- Judge depth RELATIVE to that format. A short message that makes a clear, relevant, well-reasoned point is a strong message. Do not penalize brevity itself, and do not expect essay-length development.

In your scoring output:
- "ScoreX" is ${nameX}'s score.
- "ScoreO" is ${nameO}'s score.
In your written review, refer to the players by name (${nameX} and ${nameO}). Do NOT call them "Player X", "Player O", "Player 1", or "Player 2".

YOUR TASK
1. Read the full transcript carefully, in order, tracking how each message responds to the one before it.
2. Run the side-fidelity check above (when sides are assigned): confirm each player argued their ASSIGNED side, and apply the wrong-side cap if they didn't.
3. For EACH player, list their DISTINCT arguments. Saying the same idea again in different words is the SAME argument, not a new one — merge rephrasings. Also note which of the opponent's arguments they actually answered. Apply exactly the same standard to both players.
4. Score each player independently from 0 to 10 using the scale below, based on the lists from step 3.
5. Write a 2-4 sentence review explaining the scores using the players' names. Quote or paraphrase the strongest specific argument from each side, AND name the strongest rebuttal each side made (or say plainly that they made none). If one player repeated themselves, check whether the other did too and say so. If a player was silent, hostile, or argued the wrong side, say so plainly. Do not share your personal opinion on the topic.

FAIRNESS RULES
- Polished or formal wording is NOT a stronger argument. Casual language, slang, lowercase, typos, and blunt phrasing must never lower a score. Judge the idea, not the prose.
- Repetition is judged identically for both sides. A player who restates one point in smoother words every turn is repeating just as much as a player who restates it bluntly.
- If both players made a similar number of distinct arguments and engaged the opponent a similar amount, their scores must be within 1 point of each other.
- When the debate statement is a "should" / policy / value question and neither side made a specific false factual claim, factual accuracy is a NON-factor. Do not give a side credit because their view "matches reality" or "reflects how things work" — that is agreeing with them, which is forbidden.
- A short partial concession followed by a new angle (e.g. "that is a risk, but it is a necessary one because...") IS engagement and IS a new argument. Credit it.

You do NOT pick the winner. The application code will compare the two scores numerically — your only job is to set them honestly.

WHAT COUNTS (weigh these roughly equally)
- REASONING: clear logic that actually supports their side of the statement.
- CLASH: directly answering the opponent's arguments. Engaging with the opponent's specific point — refuting it, conceding it, or showing why it is outweighed — is worth as much as introducing a new point. Ignoring the opponent's arguments is a weakness.
- SUPPORT: examples, evidence, and consequences. A specific real-world example, a concrete scenario, or a sound causal argument counts as support just as much as a statistic. A quoted number is NOT automatically stronger than good reasoning, and an unsourced statistic earns no extra credit over a well-explained example.
- RELEVANCE: staying on the exact debate statement.
- CLARITY and civility.

PENALIZE (lower the score of the player who does this)
- Ignoring a direct rebuttal and simply moving on to a new talking point.
- Repeating an argument the opponent has already answered, without adding anything new. Repetition is not persistence; it is a failure to respond.
- Drifting away from the debate statement onto side topics the opponent did not raise.
- Stacking facts or figures that do not connect to the point actually under discussion.

SCORING SCALE (apply STRICTLY — do not inflate scores out of politeness)
- 0  = did not participate at all (no messages, or only whitespace).
- 1  = only sent gibberish, spam, or a single useless message.
- 2  = ONLY insults, profanity, slurs, hate speech, or trolling. No actual argument.
- 3  = weak, off-topic, or contradictory; almost no reasoning. ALSO the minimum for a player who made at least one relevant argument for their assigned side.
       (A player who mostly argued the WRONG assigned side is capped at 1 — see side-fidelity check.)
- 4  = touches the topic but argument is unclear, unsupported, OR mostly repeats points the opponent already answered.
- 5-6 = average — makes relevant points on their assigned side but does not really engage the opponent's arguments, or offers little support for their own.
- 7-8 = strong — clear reasoning on their assigned side, directly answers the opponent's main points, and gives at least one concrete example, scenario, or piece of evidence; factually accurate.
- 9-10 = excellent — persuasive on their assigned side, answers every significant rebuttal, multiple specific well-connected points, no falsehoods.

ANY of these caps a player at 2 OR LOWER — but ONLY when that is essentially ALL the player did (they made no actual argument for their side):
- Insults, profanity, slurs, or hate speech with no actual argument.
- Personal attacks instead of addressing the question.
- Pure trolling / off-topic spam with no actual argument.
${falseClaimCap}
A player who made a real argument and ALSO sent some banter, a casual sign-off ("good one", "you too"), a joke, or an off-topic aside is NOT capped by these — score their argument on its merits and ignore the filler. Only hostility or hate speech mixed in with a real argument should cost points (deduct 1-2), never a hard cap.

DO NOT
- Do not adjust scores so they come out equal or unequal — score each player on their own merits, ignoring what the other got.
- Do not score insults or trolling as if they were arguments.
- Do not soften the score of a hostile or silent player. Reflect what actually happened.
- Do not favor the player who used more numbers or named more facts if those facts did not answer what the other player actually argued.
- Do not write "winner" or "tie" anywhere in your output. The code decides that.

Return EXACTLY this format (no markdown, no extra prose, no JSON):
PointsX: <number of distinct arguments ${nameX} made>; <number of ${nameO}'s arguments ${nameX} answered>; <one line listing ${nameX}'s distinct arguments>
PointsO: <number of distinct arguments ${nameO} made>; <number of ${nameX}'s arguments ${nameO} answered>; <one line listing ${nameO}'s distinct arguments>
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

  // The Points lines are the judge's working notes (distinct arguments per
  // side). They never reach the client; log them so fairness can be audited.
  const pointsX = findLine('pointsx:');
  const pointsO = findLine('pointso:');
  if (pointsX || pointsO) {
    console.log(`[judge] PointsX: ${pointsX}\n[judge] PointsO: ${pointsO}`);
  }

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

// ── Player name resolution ─────────────────────────────────────────────────
// The judge review should refer to players by their username, never
// "Player 1"/"Player 2". The server resolves names itself from game state +
// Firestore so both clients always see identical labels (the cached verdict
// is shared), instead of trusting whatever one client happened to send.

async function lookupHumanUsername(db, uid) {
  if (!uid) return null;
  try {
    const snap = await db.collection('publicProfiles').doc(uid).get();
    const data = snap.data() || {};
    const username = typeof data.username === 'string' ? data.username.trim() : '';
    if (username) return username;
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (name) return name;
  } catch (err) {
    console.warn(`[judge] username lookup failed for ${uid}: ${err.message}`);
  }
  return null;
}

function aiOpponentName(state) {
  const persona = state?.aiPersona;
  if (persona && typeof persona.displayName === 'string' && persona.displayName.trim()) {
    return persona.displayName.trim();
  }
  return 'The AI';
}

// Symbol mapping matches the clients' canonicalization: P1 -> X, P2 -> O.
async function resolvePlayerNames(state, rawNames) {
  const names = {
    X: sanitizeName(rawNames && rawNames.X, ''),
    O: sanitizeName(rawNames && rawNames.O, ''),
  };

  if (state) {
    const db = getDb();
    const resolve = async (uid) => {
      if (uid === AI_OPPONENT_ID) return aiOpponentName(state);
      return db ? lookupHumanUsername(db, uid) : null;
    };
    const [nameX, nameO] = await Promise.all([
      resolve(state.player1Id),
      resolve(state.player2Id),
    ]);
    // Server lookup wins over client-sent names — it's the only source both
    // clients are guaranteed to agree on.
    if (nameX) names.X = sanitizeName(nameX, names.X);
    if (nameO) names.O = sanitizeName(nameO, names.O);
  }

  if (!names.X) names.X = 'Player 1';
  if (!names.O) names.O = 'Player 2';
  return names;
}

function resolvePlayerStances(state, clientStances) {
  const stances = { X: null, O: null };

  if (state) {
    stances.X = sanitizeStance(state.player1Position);
    stances.O = sanitizeStance(state.player2Position);
  }

  if (clientStances && typeof clientStances === 'object') {
    if (!stances.X) stances.X = sanitizeStance(clientStances.X);
    if (!stances.O) stances.O = sanitizeStance(clientStances.O);
  }

  return stances;
}

// ── Shared prompt assembly ─────────────────────────────────────────────────

function buildPrompts(topic, question, safeMessages, names, stances, hasWeb) {
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
    `Debate Statement: ${question}\n` +
    sideSummary +
    `\nThe two debaters are ${nameX} (their score = ScoreX) and ${nameO} (their score = ScoreO).\n\n` +
    `Transcript:\n${transcript}`;

  return {
    system: buildSystemPrompt(todayHuman, nameX, nameO, stances, hasWeb),
    user: userPrompt,
  };
}

// ── Engines ────────────────────────────────────────────────────────────────

// Verified path: Perplexity Sonar with live web search. Tightened vs the old
// config: low search context (smallest per-request search fee tier), capped
// output, and the recency filter only when the debate is news-backed.
async function callSonar(apiKey, topic, question, safeMessages, names, stances, { recency } = {}) {
  const { system, user } = buildPrompts(topic, question, safeMessages, names, stances, true);

  const body = {
    model: PERPLEXITY_MODEL,
    temperature: 0.2,
    max_tokens: JUDGE_MAX_TOKENS,
    web_search_options: { search_context_size: 'low' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (recency) body.search_recency_filter = 'month';

  const upstream = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
  return { ...parsed, sources, judgeMode: 'verified' };
}

// Standard path: gpt-4o-mini, transcript only, no web. Same scoring rules and
// output format, ~1/10th of the verified cost.
async function callMiniJudge(apiKey, topic, question, safeMessages, names, stances) {
  const { system, user } = buildPrompts(topic, question, safeMessages, names, stances, false);

  const upstream = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: JUDGE_MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    const err = new Error(`OpenAI ${upstream.status}: ${errText}`);
    err.status = upstream.status;
    throw err;
  }

  const data = await upstream.json();
  const content = data?.choices?.[0]?.message?.content || '';

  const parsed = parseJudgeReply(content);
  return { ...parsed, sources: [], judgeMode: 'standard' };
}

// ── Walkover (no-API) results ──────────────────────────────────────────────
// One player never sent a substantive message -> the other wins by default.
// Both silent -> tie. The participant's score scales gently with how much
// they actually contributed (5 base + 1 per message, capped at 8) so a
// default win never outranks a genuinely strong judged performance.
function walkoverResult(participation, names) {
  const { X, O } = participation;

  if (X === 0 && O === 0) {
    return {
      winner: 'tie',
      scoreX: 0,
      scoreO: 0,
      review: 'Neither player sent any arguments, so there is nothing to judge.',
      sources: [],
      judgeMode: 'walkover',
    };
  }

  const participantScore = (count) => Math.min(8, 5 + Math.max(0, count - 1));

  if (X === 0) {
    return {
      winner: 'O',
      scoreX: 0,
      scoreO: participantScore(O),
      review: `${names.X} never sent an argument, so ${names.O} wins this debate by default for showing up and making their case.`,
      sources: [],
      judgeMode: 'walkover',
    };
  }

  return {
    winner: 'X',
    scoreX: participantScore(X),
    scoreO: 0,
    review: `${names.O} never sent an argument, so ${names.X} wins this debate by default for showing up and making their case.`,
    sources: [],
    judgeMode: 'walkover',
  };
}

// ── Engine runner with cross-engine fallback ───────────────────────────────
// If the chosen engine's key is missing or its call fails, fall back to the
// other one rather than erroring the whole debate. A judged result from the
// "wrong" engine beats a 502 every time.
async function runJudge({ mode, recency, topic, question, safeMessages, names, stances }) {
  const pplxKey = process.env.PERPLEXITY_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const sonar = () => callSonar(pplxKey, topic, question, safeMessages, names, stances, { recency });
  const mini = () => callMiniJudge(openaiKey, topic, question, safeMessages, names, stances);

  const attempts = [];
  if (mode === 'verified') {
    if (pplxKey) attempts.push(sonar);
    if (openaiKey) attempts.push(mini);
  } else {
    if (openaiKey) attempts.push(mini);
    if (pplxKey) attempts.push(sonar);
  }

  if (attempts.length === 0) {
    const err = new Error('No judge API keys configured (need PERPLEXITY_API_KEY and/or OPENAI_API_KEY)');
    err.status = 500;
    throw err;
  }

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      console.warn(`[judge] engine attempt failed (${err.message.slice(0, 120)}) — ${attempts.indexOf(attempt) < attempts.length - 1 ? 'falling back' : 'no fallback left'}`);
    }
  }
  throw lastErr;
}

// ── AI-game handicap ───────────────────────────────────────────────────────
// Small tilt toward the human in human-vs-AI debates. Human-vs-human games
// are never touched. Env knobs:
//   AI_GAME_HUMAN_BONUS   integer added to the human's score (default 1)
//   AI_GAME_TIE_TO_HUMAN  'true' to hand the human every post-bonus tie
//                         (default off — a tie stays a draw)
// History: launched 9/27 with bonus 1 + ties-to-human → 85% human win rate,
// zero draws. 9/29: tie rule off, then bonus removed the same night so the
// outcome was purely the judge's scores. 10/1: +1 restored (ties still
// draws) — pure scores made AI debates feel too hard.
const AI_GAME_HUMAN_BONUS = Math.max(0, parseInt(process.env.AI_GAME_HUMAN_BONUS ?? '1', 10) || 0);
const AI_GAME_TIE_TO_HUMAN = process.env.AI_GAME_TIE_TO_HUMAN === 'true';
// Below this raw score the human was silent, trolling, or hostile (the
// prompt caps those at 2) — no bonus for that.
const HANDICAP_MIN_HUMAN_SCORE = 3;

function applyAIGameHandicap(result, state) {
  if (!result || !state) return result;
  // Both knobs off: the judge's verdict is final, untouched.
  if (AI_GAME_HUMAN_BONUS === 0 && !AI_GAME_TIE_TO_HUMAN) return result;
  const humanSymbol = state.player1Id === AI_OPPONENT_ID ? 'O'
    : state.player2Id === AI_OPPONENT_ID ? 'X'
    : null;
  if (!humanSymbol) return result;

  const humanKey = humanSymbol === 'X' ? 'scoreX' : 'scoreO';
  const aiKey = humanSymbol === 'X' ? 'scoreO' : 'scoreX';
  const rawHuman = result[humanKey];
  if (typeof rawHuman !== 'number' || rawHuman < HANDICAP_MIN_HUMAN_SCORE) return result;

  const human = Math.min(10, rawHuman + AI_GAME_HUMAN_BONUS);
  const rawAI = typeof result[aiKey] === 'number' ? result[aiKey] : 0;
  // Ties go to the human; drop the AI a point so the displayed scores agree
  // with the "you won" banner instead of showing 6–6 next to a win.
  const ai = (human === rawAI && AI_GAME_TIE_TO_HUMAN) ? Math.max(0, rawAI - 1) : rawAI;
  const winner = human > ai ? humanSymbol : ai > human ? (humanSymbol === 'X' ? 'O' : 'X') : 'tie';

  if (human !== rawHuman || ai !== rawAI || winner !== result.winner) {
    console.log(`[judge] AI-game handicap: human ${rawHuman}->${human}, ai ${rawAI}->${ai}, winner ${result.winner}->${winner}`);
  }
  return { ...result, [humanKey]: human, [aiKey]: ai, winner };
}

function makeRouter() {
  const router = express.Router();

  router.post('/judge', async (req, res) => {
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

    // Load game state ONCE — stances, category, philosopher flag, ammo, and
    // player identities all come from it.
    const hasGameId = typeof gameId === 'string' && gameId.length > 0;
    const state = hasGameId ? await store.loadGameState(gameId) : null;
    const stances = resolvePlayerStances(state, rawStances);
    const names = await resolvePlayerNames(state, rawNames);

    const MAX_MESSAGES = 80;
    const safeMessages = messages
      .filter((m) => m && typeof m.text === 'string' && m.text.trim().length > 0)
      .slice(-MAX_MESSAGES);

    // Walkover rule: silent player loses, both silent ties. Reactions like
    // "[rxn:flame.fill]" don't count as participation.
    const participation = participationBySymbol(safeMessages);
    if (participation.X === 0 || participation.O === 0) {
      const result = walkoverResult(participation, names);
      if (hasGameId) {
        await store.setJudgeResult(gameId, result).catch(() => {});
      }
      return res.json(result);
    }

    const decision = decideJudgeMode({ state, messages: safeMessages });
    const recency = wantsRecencyFilter(state);
    console.log(`[judge] gameId=${gameId || 'none'} mode=${decision.mode} reason=${decision.reason} recency=${recency}`);

    const judgeArgs = {
      mode: decision.mode,
      recency,
      topic,
      question,
      safeMessages,
      names,
      stances,
    };

    // No gameId? Fall back to per-call execution (no de-duplication
    // possible). This branch is mostly for safety — iOS always sends one.
    if (!hasGameId) {
      try {
        const result = applyAIGameHandicap(await runJudge(judgeArgs), state);
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
        const result = applyAIGameHandicap(await runJudge(judgeArgs), state);
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
