// judgePolicy.js — decides HOW each finished debate gets judged.
//
// Three modes, in increasing cost order:
//   'walkover' — no API call. One (or both) players never sent a real
//                message, so the outcome is decided by rule: silent player
//                loses, both silent is a tie.
//   'standard' — gpt-4o-mini judges argument quality from the transcript
//                alone (~$0.001/debate). Used when nothing in the debate
//                needs live fact-checking.
//   'verified' — Perplexity Sonar judges WITH live web search
//                (~$0.006-0.01/debate). Used when the debate leans on
//                factual/current-events claims that deserve verification.
//
// Routing principles (tuned to keep quality while cutting spend):
//   1. Only HUMAN-authored claims force verification when the AI opponent is
//      speaking from pre-verified ammo (the collector generated that ammo
//      with Perplexity at topic-creation time — re-verifying it every debate
//      would be paying twice for the same facts). If an AI game has NO ammo
//      (custom AI debates, fallback questions), the AI is improvising, so its
//      messages count toward the factual scan too.
//   2. News-backed categories (trendingUSA, politicsWorld, sports, aiFuture)
//      get a broader trigger set: current-events claims phrased WITHOUT
//      numbers ("trump signed a new tariff law") still route to verification.
//   3. Philosopher debates about a live news question are current-events
//      debates in costume — verify them. Philosopher debates on evergreen
//      fallback statements ("Virtue can be taught.") are pure reasoning —
//      the standard judge handles those.
//   4. Custom/unknown topics only verify on strong factual signals (numbers,
//      statistics, cited studies), since the statement itself is
//      player-written and often pure opinion.

const AI_OPPONENT_ID = '__trendspark_ai_opponent__';

// Categories whose questions come from the live RSS → Firestore pipeline.
const NEWS_GAME_TYPES = new Set(['religion', 'currentPolitics', 'sportsDebate', 'aiFuture']);

// Cosmetic reaction messages look like "[rxn:flame.fill]" — they are not
// arguments and don't count as participation.
const REACTION_RE = /^\s*\[rxn:[^\]]*\]\s*$/i;

function isSubstantiveText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0) return false;
  if (REACTION_RE.test(t)) return false;
  return true;
}

// ── Factual-claim detection ────────────────────────────────────────────────
// STRONG signals: concrete quantitative or sourced claims. These force
// verification on EVERY topic, because a made-up number that goes unchecked
// is the worst judging failure mode.
const STRONG_FACT_PATTERNS = [
  /\b(19|20)\d{2}\b/,                                          // years (1900–2099)
  /\d+(?:\.\d+)?\s*(?:%|percent\b|per cent\b)/i,               // percentages
  /[$€£¥]\s?\d/,                                               // money
  /\b\d[\d,]*(?:\.\d+)?\s*(?:million|billion|trillion|thousand)\b/i,
  /\b\d{4,}\b/,                                                // big raw numbers
  /\b\d+\s*(?:deaths?|casualties|jobs|votes|points|goals|wins|losses|seats|troops|people|users|dollars)\b/i,
  /\b(?:according to|study|studies|research(?:ers)? (?:show|shows|found|says)|statistic(?:s)?|survey|poll(?:s|ing)?|data (?:shows?|says?)|report(?:ed|s)? (?:that|by)|sources? say)\b/i,
];

// CURRENT-EVENTS signals: claims about who holds power, what just happened,
// what is legal, who won — checkable against today's web even with no digits.
// Only applied on news-backed topics, where such claims are the norm.
const CURRENT_EVENTS_PATTERNS = [
  /\b(?:president|prime minister|chancellor|congress|senate|supreme court|white house|parliament|governor|federal reserve)\b/i,
  /\b(?:trump|biden|harris|putin|zelensky|netanyahu|xi jinping|musk)\b/i,
  /\b(?:signed|passed|vetoed|repealed)\s+(?:a\s|an\s|the\s)?(?:law|bill|order|ban|treaty|deal)\b/i,
  /\b(?:banned|outlawed|legalized|made illegal|now legal|new law|executive order|tariffs?|sanctions?)\b/i,
  /\b(?:was|got|been)\s+(?:elected|arrested|convicted|impeached|indicted|fired|traded|suspended)\b/i,
  /\b(?:won|lost)\s+the\s+(?:election|war|game|series|title|championship|finals?|cup)\b/i,
  /\b(?:died|passed away|resigned|stepped down|retired from|signed with)\b/i,
  /\b(?:invaded|invasion|airstrikes?|ceasefire|hostages?|at war|declared war)\b/i,
  /\b(?:recession|inflation (?:is|hit|rose)|gdp|unemployment rate|interest rates?|stock market (?:crash|record))\b/i,
  /\b(?:just (?:happened|announced|signed|won|released)|last (?:week|month|night)|this (?:week|month|year)|yesterday|breaking news|right now|as of (?:now|today))\b/i,
];

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

function hasStrongFactClaims(text) {
  return matchesAny(STRONG_FACT_PATTERNS, text);
}

function hasCurrentEventsClaims(text) {
  return matchesAny(CURRENT_EVENTS_PATTERNS, text);
}

// ── Participation split ────────────────────────────────────────────────────
// Counts substantive (non-reaction) messages per canonical symbol.
function participationBySymbol(messages) {
  const counts = { X: 0, O: 0 };
  for (const m of messages || []) {
    if (!m || !isSubstantiveText(m.text)) continue;
    if (m.player === 'O') counts.O += 1;
    else counts.X += 1; // default anything non-O to X (client only sends X/O)
  }
  return counts;
}

// ── Mode decision ──────────────────────────────────────────────────────────
// state may be null (no gameId / Redis miss) — falls back to transcript-only
// heuristics with the conservative default for unknown topics.
function decideJudgeMode({ state, messages }) {
  const gameType = state?.gameType || null;
  const philosopher = state?.philosopher || null;
  const isAIGame = Boolean(state?.isAIGame)
    || state?.player1Id === AI_OPPONENT_ID
    || state?.player2Id === AI_OPPONENT_ID;
  const hasVerifiedAmmo = Boolean(
    state?.debateAmmo
    && (Array.isArray(state.debateAmmo.support) || Array.isArray(state.debateAmmo.oppose))
  );
  // Canonical mapping: player1 -> X, player2 -> O (mirrors the iOS client).
  const aiSymbol = state?.player1Id === AI_OPPONENT_ID ? 'X'
    : state?.player2Id === AI_OPPONENT_ID ? 'O'
    : null;

  // Which messages count toward the factual scan?
  //  - Human messages always.
  //  - AI messages only when the AI had no pre-verified ammo to draw from
  //    (then its "facts" are improvised and worth checking).
  const scanned = (messages || []).filter((m) => {
    if (!m || !isSubstantiveText(m.text)) return false;
    if (isAIGame && aiSymbol && m.player === aiSymbol && hasVerifiedAmmo) return false;
    return true;
  });
  const scannedText = scanned.map((m) => m.text).join('\n');

  const strong = hasStrongFactClaims(scannedText);
  const isNewsTopic = gameType ? NEWS_GAME_TYPES.has(gameType) : false;

  // Philosopher debates: verify when the question is news-backed (live
  // questionId or collector ammo attached); otherwise standard unless the
  // human made hard factual claims.
  if (philosopher) {
    const newsBacked = Boolean(state?.questionId) || hasVerifiedAmmo;
    if (newsBacked || strong) {
      return {
        mode: 'verified',
        reason: newsBacked ? 'philosopher-news-question' : 'philosopher-strong-claims',
      };
    }
    return { mode: 'standard', reason: 'philosopher-evergreen' };
  }

  if (isNewsTopic) {
    // News debates verify on either signal tier; pure-opinion exchanges
    // ("nah the refs were fine, you're just salty") stay on the cheap judge.
    if (strong) return { mode: 'verified', reason: 'news-strong-claims' };
    if (hasCurrentEventsClaims(scannedText)) {
      return { mode: 'verified', reason: 'news-current-events-claims' };
    }
    return { mode: 'standard', reason: 'news-pure-opinion' };
  }

  // Custom + unknown topics: only strong quantitative/sourced claims warrant
  // the search fee.
  if (strong) return { mode: 'verified', reason: 'strong-claims' };
  return { mode: 'standard', reason: 'no-factual-claims' };
}

// Should the Sonar call restrict search to the last month? Yes for news-backed
// debates (facts track the news cycle); no for evergreen/custom statements,
// where month-old-only sources would HURT (e.g. historical facts).
function wantsRecencyFilter(state) {
  const gameType = state?.gameType || null;
  if (gameType && NEWS_GAME_TYPES.has(gameType)) return true;
  if (state?.philosopher && (state?.questionId || state?.debateAmmo)) return true;
  return false;
}

module.exports = {
  AI_OPPONENT_ID,
  NEWS_GAME_TYPES,
  isSubstantiveText,
  hasStrongFactClaims,
  hasCurrentEventsClaims,
  participationBySymbol,
  decideJudgeMode,
  wantsRecencyFilter,
};
