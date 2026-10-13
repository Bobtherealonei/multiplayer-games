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
// Overridable so a local run can point the judge at a mock endpoint.
const OPENAI_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
// One judge call per debate decides who wins trophies — worth a full-size
// model (~$0.004/debate on gpt-4.1 vs ~$0.0003 on gpt-4o-mini). The mini
// model over-rewarded whichever side quoted more facts, which in AI games
// is always the AI (it is handed news facts every turn).
const OPENAI_MODEL = 'gpt-4.1';

// Working notes + 8 category lines (grade + one sentence each) + scores +
// a 2-4 sentence review. ~600 tokens typical; headroom for long notes.
const JUDGE_MAX_TOKENS = 900;

// Category weights for the overall score. Must sum to 1.
const JUDGE_CATEGORIES = [
  { key: 'logic', label: 'Logic', weight: 0.35 },
  { key: 'evidence', label: 'Evidence', weight: 0.25 },
  { key: 'rebuttals', label: 'Rebuttals', weight: 0.25 },
  { key: 'clarity', label: 'Clarity', weight: 0.15 },
];

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
function buildSystemPrompt(todayHuman, nameX, nameO, stances, hasWeb, overtime = null) {
  const sideBlock = buildSideInstructions(nameX, nameO, stances);

  // Tie-break pass: the regulation turns were already scored (and tied).
  // Only the two messages tagged OVERTIME are being graded now.
  const overtimeBlock = overtime
    ? `
OVERTIME ROUND — READ THIS FIRST
- The regulation debate was already judged and ended in a TIE (${overtime.regulation.scoreX}-${overtime.regulation.scoreO}). Each player then got ONE extra message. Those are the transcript lines tagged "OVERTIME".
- Score ONLY the OVERTIME messages. ScoreX/ScoreO, the four category grades, the Points lines, and the review all describe the overtime messages alone.
- Untagged (regulation) lines are context only: use them to judge whether an overtime message answers what the opponent actually argued, builds on the debate, or just repeats something already said. Do NOT re-score them and do NOT let the regulation performance pull the overtime score up or down.
- An overtime message that repeats the player's own earlier points word-for-word adds nothing new — grade it like repetition. One that answers the opponent's strongest regulation point, or lands a new on-side argument, is a strong overtime message.
- The second overtime speaker had the chance to rebut the first; the first speaker could only rebut regulation. Judge each against what was available to them.
- Keep the review to 2-3 sentences about the overtime messages only.
`
    : '';

  const factLine = hasWeb
    ? 'You have access to the live web. Use it ONLY to check specific factual claims a player actually made (a number, a date, an event, a law). Do NOT research the debate topic itself, and never give a player credit because your research agrees with their side — that is taking sides, which is forbidden.'
    : 'You do NOT have web access. Judge argument quality, clarity, relevance, and reasoning. Penalize claims that are clearly false by well-established common knowledge, but do NOT guess about very recent events you cannot verify — score those on reasoning alone.';

  const falseClaimCap = hasWeb
    ? '- Made significant factually false claims that current web sources contradict.'
    : '- Made significant claims that are clearly false by well-established common knowledge.';

  return `You are an impartial AI debate judge. Two players just had a short debate: ${nameX} and ${nameO}. Today is ${todayHuman}. ${factLine}
${sideBlock}
${overtimeBlock}
FORMAT OF THIS DEBATE
- Players alternate turns. Each turn is a chat message typed under a clock of roughly one minute, so messages are short (often one or two sentences).
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

THE FOUR CATEGORIES (grade each 0-10 per player; the overall score is their weighted combination)
- LOGIC (35%): does their reasoning actually support their side of the statement, and does it hold together? Deduct for logical fallacies — ad hominem (attacking the person), strawman (arguing against something the opponent did not say), moving the goalposts, false dilemma, circular reasoning, appeal to popularity. Name the fallacy in the note when you deduct for one. Staying on the exact debate statement is part of logic; drifting onto side topics costs here.
- EVIDENCE (25%): do they back their claims with something checkable — a specific real-world example, a concrete scenario, a named event, a number, a sound causal chain — rather than pure personal opinion? A specific example counts as much as a statistic. An unsourced or false statistic earns nothing. ${hasWeb ? 'Where you verified a claim, say whether it held up.' : 'Credit specificity; do not guess about claims you cannot check.'}
- REBUTTALS (25%): did they directly answer what the opponent actually said? Refuting, conceding, or outweighing the opponent's specific point is worth as much as a new argument. If the opponent made an important point and this player never addressed it, that is a DROPPED ARGUMENT — say which one in the note and grade down. Dodging a direct question to pivot to a new talking point also costs here.
- CLARITY (15%): readable, concise, civil. Casual language, slang, lowercase and typos do NOT lower this. Toxicity, insults, or spamming lower it sharply.

For each category write ONE short, plain sentence (max 18 words) addressed to the player, e.g. "You never answered their point about cost." or "Strong — you gave a concrete example about Manuel." Be specific, not generic.

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

OVERALL SCORE: ScoreX / ScoreO must be the weighted combination of that player's four category grades (0.35×Logic + 0.25×Evidence + 0.25×Rebuttals + 0.15×Clarity, rounded), THEN adjusted by the hard rules above: the wrong-side cap (1), the no-argument caps (2 or lower), the floor of 3 for anyone who made at least one real on-side argument, and 0 for a player who did not participate. When a cap or floor changes the score, make the category grades honest anyway — the cap is applied on top.

Return EXACTLY this format (no markdown, no extra prose, no JSON):
PointsX: <number of distinct arguments ${nameX} made>; <number of ${nameO}'s arguments ${nameX} answered>; <one line listing ${nameX}'s distinct arguments>
PointsO: <number of distinct arguments ${nameO} made>; <number of ${nameX}'s arguments ${nameO} answered>; <one line listing ${nameO}'s distinct arguments>
LogicX: <0-10>; <one sentence to ${nameX}>
EvidenceX: <0-10>; <one sentence to ${nameX}>
RebuttalsX: <0-10>; <one sentence to ${nameX}>
ClarityX: <0-10>; <one sentence to ${nameX}>
LogicO: <0-10>; <one sentence to ${nameO}>
EvidenceO: <0-10>; <one sentence to ${nameO}>
RebuttalsO: <0-10>; <one sentence to ${nameO}>
ClarityO: <0-10>; <one sentence to ${nameO}>
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
  const modelScoreX = parseScore(findLine('scorex:'));
  const modelScoreO = parseScore(findLine('scoreo:'));
  const review = findLine('review:') || (content || '').trim();

  // Category breakdown: "LogicX: 7; You never answered their cost point."
  // Optional — an older cached verdict or a malformed reply simply has no
  // breakdown and the overall falls back to the model's ScoreX/ScoreO.
  const parseCategory = (raw) => {
    if (!raw) return null;
    const semi = raw.indexOf(';');
    const numPart = semi >= 0 ? raw.slice(0, semi) : raw;
    const n = parseInt(numPart, 10);
    if (!Number.isFinite(n)) return null;
    const note = semi >= 0 ? raw.slice(semi + 1).trim().slice(0, 160) : '';
    return { score: Math.max(0, Math.min(10, n)), note };
  };
  const parseBreakdown = (suffix) => {
    const out = {};
    for (const c of JUDGE_CATEGORIES) {
      const parsed = parseCategory(findLine(`${c.key}${suffix}:`));
      if (!parsed) return null; // all four or nothing
      out[c.key] = parsed;
    }
    return out;
  };
  const breakdownX = parseBreakdown('x');
  const breakdownO = parseBreakdown('o');

  // Overall = weighted categories, with the model's hard rules kept on top:
  // a model score of 0-2 is a cap (silent / wrong side / trolling) and wins;
  // otherwise anyone the model scored >= 3 keeps the floor of 3.
  const weighted = (b) =>
    Math.round(JUDGE_CATEGORIES.reduce((sum, c) => sum + c.weight * b[c.key].score, 0));
  const combine = (b, modelScore) => {
    if (!b) return modelScore;
    if (modelScore <= 2) return modelScore;
    return Math.max(3, Math.min(10, weighted(b)));
  };
  const scoreX = combine(breakdownX, modelScoreX);
  const scoreO = combine(breakdownO, modelScoreO);
  if (scoreX !== modelScoreX || scoreO !== modelScoreO) {
    console.log(`[judge] overall recomputed from categories: X ${modelScoreX}->${scoreX}, O ${modelScoreO}->${scoreO}`);
  }

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

  return {
    winner,
    scoreX,
    scoreO,
    review,
    ...(breakdownX && breakdownO ? { breakdownX, breakdownO } : {}),
  };
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

  // Hidden-opponent games (side-select): keep the review anonymous so it
  // can't leak who — or what — the other side was.
  const hidden = state && (state.hiddenOpponent === true || state.hiddenOpponent === 'true');

  if (state && !hidden) {
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

  if (hidden || !names.X) names.X = 'Player 1';
  if (hidden || !names.O) names.O = 'Player 2';
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

function buildPrompts(topic, question, safeMessages, names, stances, hasWeb, overtime = null) {
  const nameX = names.X;
  const nameO = names.O;

  const transcript = safeMessages
    .map((m) => {
      const isO = m.player === 'O';
      const label = isO ? nameO : nameX;
      const side = isO ? stances.O : stances.X;
      const sideTag = stanceShortLabel(side);
      const otTag = overtime && m.overtime ? 'OVERTIME · ' : '';
      const prefix = sideTag ? `[${otTag}${label} (${sideTag})]` : `[${otTag}${label}]`;
      return `${prefix}: ${m.text.trim()}`;
    })
    .join('\n');

  const overtimeUserBlock = overtime
    ? `\nOVERTIME: regulation ended tied ${overtime.regulation.scoreX}-${overtime.regulation.scoreO}. ` +
      `Score ONLY the messages tagged OVERTIME. Untagged messages are context so you can tell whether an overtime message answers the opponent.\n`
    : '';

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
    overtimeUserBlock +
    `\nThe two debaters are ${nameX} (their score = ScoreX) and ${nameO} (their score = ScoreO).\n\n` +
    `Transcript:\n${transcript}`;

  return {
    system: buildSystemPrompt(todayHuman, nameX, nameO, stances, hasWeb, overtime),
    user: userPrompt,
  };
}

// ── Engines ────────────────────────────────────────────────────────────────

// Verified path: Perplexity Sonar with live web search. Tightened vs the old
// config: low search context (smallest per-request search fee tier), capped
// output, and the recency filter only when the debate is news-backed.
async function callSonar(apiKey, topic, question, safeMessages, names, stances, { recency, overtime } = {}) {
  const { system, user } = buildPrompts(topic, question, safeMessages, names, stances, true, overtime);

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
async function callMiniJudge(apiKey, topic, question, safeMessages, names, stances, { overtime } = {}) {
  const { system, user } = buildPrompts(topic, question, safeMessages, names, stances, false, overtime);

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
async function runJudge({ mode, recency, topic, question, safeMessages, names, stances, overtime = null }) {
  const pplxKey = process.env.PERPLEXITY_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const sonar = () => callSonar(pplxKey, topic, question, safeMessages, names, stances, { recency, overtime });
  const mini = () => callMiniJudge(openaiKey, topic, question, safeMessages, names, stances, { overtime });

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

// ── AI games ───────────────────────────────────────────────────────────────
// Human-vs-AI debates are scored exactly like human games. The old +1
// "handicap" for the human (9/27 → 10/12) was removed when tie-break
// overtime shipped: with the bonus gone an AI game can tie, and a tie now
// goes to overtime instead of being nudged into a win.

// ── Overtime (tie-break) ───────────────────────────────────────────────────
// A judged tie in regulation — both sides actually spoke and the judge
// scored them equal — gets ONE extra turn each: the player who closed
// regulation (P1) now goes second, so P2 opens overtime and P1 closes it.
// The judge then scores ONLY the two overtime messages (with the whole
// transcript as context) and the final verdict is regulation + overtime.
// Still tied after that? It stays a tie. Only one overtime per game.
//
// Wire protocol:
//   • Regulation /judge (phase omitted) — if the verdict is a real tie and
//     both clients advertised the `overtime` capability at connect, the
//     server patches the game (overtimeStartedAt / overtimeChatIndex /
//     overtimeFirst), emits `overtimeStarted` to the game room, and the
//     cached regulation result carries `overtimePending: true`.
//   • Overtime /judge (phase: 'overtime') — scored from the SERVER's chatLog
//     split at overtimeChatIndex (robust to a client that relaunched and
//     replayed chat history), cached under judge:{gameId}:ot, and returned
//     with `phase: 'final'`, `wasOvertime: true`, `regulation` and
//     `overtime` score lines. Rewards settle only on this final verdict
//     (see rewards.js getFinalJudgeResult).
const OVERTIME_ENABLED = process.env.OVERTIME_ENABLED !== 'false';
const MAX_MESSAGES = 80;

function overtimeKey(gameId) {
  return `${gameId}:ot`;
}

function overtimeStartedAt(state) {
  const n = Number(state?.overtimeStartedAt);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function overtimeAllowed(state) {
  if (!OVERTIME_ENABLED || !state) return false;
  return state.overtimeEligible === true || state.overtimeEligible === 'true';
}

// Leader-only: called with the fresh regulation verdict before it's cached.
// Starts overtime when the verdict is a genuine tie and the game can do it.
async function maybeStartOvertime(io, gameId, state, result) {
  if (!result || result.winner !== 'tie' || result.judgeMode === 'walkover') return result;
  if (!overtimeAllowed(state)) return result;
  if (overtimeStartedAt(state)) return { ...result, phase: 'regulation', overtimePending: true };

  const startedAt = Date.now();
  const chatLog = Array.isArray(state.chatLog) ? state.chatLog : [];
  const firstSymbol = state.player2Symbol || 'P2';
  await store.patchGameState(gameId, {
    overtimeStartedAt: startedAt,
    overtimeChatIndex: chatLog.length,
    overtimeFirst: firstSymbol,
  });
  const createdAt = Number(state.createdAt) || startedAt;
  const payload = {
    gameId,
    clockElapsedMs: 0,
    // Overtime start measured from game creation (same clock as the
    // finishedTurns history) and the chatLog split point.
    startedElapsedMs: Math.max(0, startedAt - createdAt),
    chatIndex: chatLog.length,
    firstSymbol,
    regulation: { scoreX: result.scoreX, scoreO: result.scoreO },
  };
  if (io) io.to(`game:${gameId}`).emit('overtimeStarted', payload);
  console.log(`[judge] overtime started gameId=${gameId} tie ${result.scoreX}-${result.scoreO} first=${firstSymbol} chatIndex=${chatLog.length}`);
  return { ...result, phase: 'regulation', overtimePending: true, overtimeStartedAt: startedAt, overtimeFirst: firstSymbol };
}

// Every regulation response that says "overtime pending" also carries how
// far into overtime the server clock already is, so a client that missed
// the `overtimeStarted` socket event (or fetched the cached verdict a few
// seconds later) can still anchor its overtime clock. Absolute timestamps
// are never trusted client-side — only this elapsed delta.
function withOvertimeClock(result, state) {
  if (!result || !result.overtimePending) return result;
  const startedAt = overtimeStartedAt(state) || (Number(result.overtimeStartedAt) > 0 ? Number(result.overtimeStartedAt) : null);
  if (!startedAt) return result;
  return { ...result, overtimeElapsedMs: Math.max(0, Date.now() - startedAt) };
}

// Overtime walkover: one side said nothing in the extra round, so the other
// takes the tie-break. Both silent -> the tie stands.
function overtimeWalkoverResult(participation, names) {
  const { X, O } = participation;
  if (X === 0 && O === 0) {
    return {
      winner: 'tie',
      scoreX: 0,
      scoreO: 0,
      review: 'Neither player added anything in overtime, so the tie stands.',
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
      review: `${names.X} stayed silent in overtime, so ${names.O} takes the tie-break for making a closing case.`,
      sources: [],
      judgeMode: 'walkover',
    };
  }
  return {
    winner: 'X',
    scoreX: participantScore(X),
    scoreO: 0,
    review: `${names.O} stayed silent in overtime, so ${names.X} takes the tie-break for making a closing case.`,
    sources: [],
    judgeMode: 'walkover',
  };
}

// The server's chatLog is the source of truth for which messages were
// overtime: everything at or after overtimeChatIndex. Symbols are P1/P2 on
// the wire; the judge speaks X/O (P1 = X).
function overtimeTranscript(state) {
  const chatLog = Array.isArray(state.chatLog) ? state.chatLog : [];
  const rawSplit = parseInt(state.overtimeChatIndex, 10);
  const splitAt = Number.isFinite(rawSplit) ? Math.max(0, Math.min(chatLog.length, rawSplit)) : chatLog.length;
  const p1 = state.player1Symbol || 'P1';
  return chatLog
    .map((entry, index) => ({
      player: entry?.symbol === p1 ? 'X' : 'O',
      text: typeof entry?.text === 'string' ? entry.text : '',
      overtime: index >= splitAt,
    }))
    .filter((m) => m.text.trim().length > 0);
}

function composeFinalResult(regulation, overtime) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const otX = num(overtime.scoreX);
  const otO = num(overtime.scoreO);
  const regX = num(regulation.scoreX);
  const regO = num(regulation.scoreO);
  const winner = otX > otO ? 'X' : otO > otX ? 'O' : 'tie';
  return {
    winner,
    scoreX: regX + otX,
    scoreO: regO + otO,
    review: overtime.review,
    sources: Array.isArray(overtime.sources) ? overtime.sources : [],
    judgeMode: overtime.judgeMode,
    ...(overtime.breakdownX && overtime.breakdownO
      ? { breakdownX: overtime.breakdownX, breakdownO: overtime.breakdownO }
      : {}),
    phase: 'final',
    wasOvertime: true,
    regulation: { scoreX: regX, scoreO: regO, review: regulation.review || null },
    overtime: { scoreX: otX, scoreO: otO },
  };
}

async function runOvertimeJudge({ state, regulation, topic, question, names, stances }) {
  const all = overtimeTranscript(state);
  const otMessages = all.filter((m) => m.overtime);
  const participation = participationBySymbol(otMessages);
  let verdict;
  if (participation.X === 0 || participation.O === 0) {
    verdict = overtimeWalkoverResult(participation, names);
  } else {
    const decision = decideJudgeMode({ state, messages: otMessages });
    const recency = wantsRecencyFilter(state);
    console.log(`[judge] overtime gameId=${state.gameId || '?'} mode=${decision.mode} reason=${decision.reason} recency=${recency} otMessages=${otMessages.length}`);
    verdict = await runJudge({
      mode: decision.mode,
      recency,
      topic,
      question,
      safeMessages: all.slice(-MAX_MESSAGES),
      names,
      stances,
      overtime: { regulation: { scoreX: regulation.scoreX, scoreO: regulation.scoreO } },
    });
  }
  return composeFinalResult(regulation, verdict);
}

function errorStatus(err) {
  return err.status && err.status >= 400 && err.status < 600 ? 502 : 500;
}

function makeRouter({ io = null } = {}) {
  const router = express.Router();

  router.post('/judge', async (req, res) => {
    const {
      topic = '',
      question = '',
      messages = [],
      gameId = '',
      phase = 'regulation',
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
    if (state && !state.gameId) state.gameId = gameId;
    const stances = resolvePlayerStances(state, rawStances);
    const names = await resolvePlayerNames(state, rawNames);

    // ── Overtime pass ──
    if (phase === 'overtime') {
      if (!state || !overtimeStartedAt(state)) {
        return res.status(409).json({ error: 'This game is not in overtime' });
      }
      const key = overtimeKey(gameId);
      const cachedFinal = await store.getJudgeResult(key);
      if (cachedFinal) return res.json(cachedFinal);

      const regulation = await store.getJudgeResult(gameId);
      if (!regulation) {
        return res.status(409).json({ error: 'Regulation verdict is no longer available' });
      }

      const gotLock = await store.tryAcquireJudgeLock(key);
      if (gotLock) {
        try {
          // The previous leader may have finished between our cache miss
          // and this lock — don't pay for a second identical verdict.
          const raced = await store.getJudgeResult(key);
          if (raced) return res.json(raced);
          const result = await runOvertimeJudge({ state, regulation, topic, question, names, stances });
          await store.setJudgeResult(key, result);
          return res.json(result);
        } catch (err) {
          console.error('[judge] overtime error:', err.message);
          return res.status(errorStatus(err)).json({ error: 'Judge failed' });
        } finally {
          await store.releaseJudgeLock(key);
        }
      }

      const result = await waitForCachedResult(key);
      if (result) return res.json(result);
      console.warn(`[judge] timed out waiting for overtime result for gameId=${gameId}`);
      return res.status(504).json({ error: 'Judge timed out' });
    }

    // ── Regulation pass ──
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
        const result = await runJudge(judgeArgs);
        return res.json(result);
      } catch (err) {
        console.error('[judge] error:', err.message);
        return res.status(errorStatus(err)).json({ error: 'Judge failed' });
      }
    }

    // Step 1: cached?
    const cached = await store.getJudgeResult(gameId);
    if (cached) return res.json(withOvertimeClock(cached, state));

    // Step 2: try to be the leader for this gameId.
    const gotLock = await store.tryAcquireJudgeLock(gameId);
    if (gotLock) {
      try {
        const raced = await store.getJudgeResult(gameId);
        if (raced) return res.json(withOvertimeClock(raced, state));
        const result = await maybeStartOvertime(io, gameId, state, await runJudge(judgeArgs));
        await store.setJudgeResult(gameId, result);
        return res.json(withOvertimeClock(result, state));
      } catch (err) {
        console.error('[judge] error:', err.message);
        return res.status(errorStatus(err)).json({ error: 'Judge failed' });
      } finally {
        // Release ASAP so a retry after a failure doesn't have to wait
        // out the lock TTL.
        await store.releaseJudgeLock(gameId);
      }
    }

    // Step 3: someone else is computing — wait for their result.
    const result = await waitForCachedResult(gameId);
    if (result) return res.json(withOvertimeClock(result, state));

    console.warn(`[judge] timed out waiting for cached result for gameId=${gameId}`);
    return res.status(504).json({ error: 'Judge timed out' });
  });

  return router;
}

// Final verdict for settlement: the overtime result when the game went to
// overtime, the regulation result otherwise, and null while a regulation
// tie is still waiting on its overtime (nothing to settle yet).
async function getFinalJudgeResult(gameId) {
  const regulation = await store.getJudgeResult(gameId);
  if (!regulation) return null;
  if (!regulation.overtimePending) return regulation;
  return store.getJudgeResult(overtimeKey(gameId));
}

// Is a verdict being computed right now — either pass? Used by the leave
// handling so a Pass tapped during "Reviewing the debate…" isn't a forfeit.
async function isFinalJudgeInProgress(gameId) {
  const [regulation, overtime] = await Promise.all([
    store.isJudgeInProgress(gameId).catch(() => false),
    store.isJudgeInProgress(overtimeKey(gameId)).catch(() => false),
  ]);
  return regulation || overtime;
}

module.exports = { makeRouter, getFinalJudgeResult, isFinalJudgeInProgress, overtimeKey };
