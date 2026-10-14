// Server-side view of the debate clock.
//
// The phones run the schedule themselves (DebateTopicView.turnSchedule /
// turnEndElapsed / effectiveElapsed) anchored to the server's createdAt, so
// the server can reproduce the same clock from the game state alone and use
// it to decide what is allowed right now: whose turn it is, whether the
// debate (or overtime) is over, whether a Pass is plausible. Everything here
// is pure; callers pass `now`.
//
// Mirror of the client rules:
//   • 8 regulation turns, P1 first, each `turnSeconds` of chat.
//   • Every HUMAN turn is preceded by `thinkingSeconds` (input locked). Turns
//     of a quick-answer AI opponent skip it; the side-select stand-in
//     (aiFallback) keeps it.
//   • The clock starts INTRO_MS after createdAt (intro card).
//   • Finish Turn jumps the clock to the end of that turn: each finishedTurns
//     event adds (boundary − effective-at-event) to a running "skipped" total.
//   • Overtime: two more turns, overtimeFirst then the other, anchored at
//     overtimeStartedAt, with their own skipped total.

const REGULATION_TURNS = 8;
const OVERTIME_TURNS = 2;
const INTRO_MS = 2800; // DebateTopicViewModel.introCardSeconds
const DEFAULT_TURN_SECONDS = 45; // what a client assumes until state arrives
const DEFAULT_THINKING_SECONDS = 10;
const AI_OPPONENT_ID = '__trendspark_ai_opponent__';

const isTrue = (v) => v === true || v === 'true';

function turnSeconds(state) {
  const n = Number(state?.turnSeconds);
  return n > 0 ? n : DEFAULT_TURN_SECONDS;
}

function thinkingSeconds(state) {
  const n = Number(state?.thinkingSeconds);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THINKING_SECONDS;
}

/** Symbol ('P1'/'P2') of the given player, or null if not in the game. */
function symbolFor(state, playerId) {
  if (!state || !playerId) return null;
  if (state.player1Id === playerId) return state.player1Symbol || 'P1';
  if (state.player2Id === playerId) return state.player2Symbol || 'P2';
  return null;
}

/** Symbol whose turns have no thinking prefix (quick-answer AI), or null. */
function thinkingSkipSymbol(state) {
  const isAI = isTrue(state?.isAIGame) || state?.player1Id === AI_OPPONENT_ID || state?.player2Id === AI_OPPONENT_ID;
  if (!isAI || isTrue(state?.aiFallback)) return null;
  return state.player1Id === AI_OPPONENT_ID ? (state.player1Symbol || 'P1') : (state.player2Symbol || 'P2');
}

function overtimeStartedAt(state) {
  const n = Number(state?.overtimeStartedAt);
  return n > 0 ? n : null;
}

/** [{ index, symbol, seconds, thinking }] for regulation (+ overtime if open). */
function schedule(state) {
  const secs = turnSeconds(state);
  const think = thinkingSeconds(state);
  const skip = thinkingSkipSymbol(state);
  const turns = [];
  for (let i = 0; i < REGULATION_TURNS; i += 1) {
    const symbol = i % 2 === 0 ? 'P1' : 'P2';
    turns.push({ index: i, symbol, seconds: secs, thinking: symbol === skip ? 0 : think });
  }
  if (overtimeStartedAt(state)) {
    const first = state.overtimeFirst === 'P1' ? 'P1' : 'P2';
    const second = first === 'P1' ? 'P2' : 'P1';
    for (const symbol of [first, second]) {
      turns.push({ index: turns.length, symbol, seconds: secs, thinking: symbol === skip ? 0 : think });
    }
  }
  return turns;
}

/** Cumulative seconds at which turn `index` ENDS (thinking prefixes included). */
function turnEndSeconds(turns, index) {
  let end = 0;
  for (let i = 0; i <= index && i < turns.length; i += 1) {
    end += turns[i].thinking + turns[i].seconds;
  }
  return end;
}

function finishedEvents(state) {
  return (Array.isArray(state?.finishedTurns) ? state.finishedTurns : [])
    .filter((e) => e && Number.isInteger(e.turnIndex) && Number(e.atMs) > 0)
    .sort((a, b) => Number(a.atMs) - Number(b.atMs));
}

/**
 * Seconds of debate clock elapsed right now, skips included. Returns null
 * when the game has no createdAt (nothing to anchor to).
 */
function effectiveElapsedSeconds(state, now = Date.now()) {
  const createdAt = Number(state?.createdAt);
  if (!(createdAt > 0)) return null;
  const turns = schedule(state);
  const events = finishedEvents(state);
  const regulationEnd = turnEndSeconds(turns, REGULATION_TURNS - 1);

  // Regulation skips: every event is measured from game creation; the clock
  // itself starts after the intro card.
  let skipped = 0;
  for (const e of events) {
    if (e.turnIndex < 0 || e.turnIndex >= REGULATION_TURNS) continue;
    const sinceClockStart = Math.max(0, (Number(e.atMs) - createdAt - INTRO_MS) / 1000);
    const effective = sinceClockStart + skipped;
    const boundary = turnEndSeconds(turns, e.turnIndex);
    if (boundary > effective) skipped += boundary - effective;
  }

  const otStart = overtimeStartedAt(state);
  if (otStart) {
    let otSkipped = 0;
    for (const e of events) {
      if (e.turnIndex < REGULATION_TURNS || e.turnIndex >= turns.length) continue;
      const sinceOT = Math.max(0, (Number(e.atMs) - otStart) / 1000);
      const effective = regulationEnd + sinceOT + otSkipped;
      const boundary = turnEndSeconds(turns, e.turnIndex);
      if (boundary > effective) otSkipped += boundary - effective;
    }
    return regulationEnd + Math.max(0, (now - otStart) / 1000) + otSkipped;
  }

  const sinceClockStart = Math.max(0, (now - createdAt - INTRO_MS) / 1000);
  return sinceClockStart + skipped;
}

/**
 * Where the debate stands: the active turn (or `index === turns.length`
 * once everything has run out), whether we're inside its thinking prefix,
 * and seconds left in it.
 */
function currentTurn(state, now = Date.now()) {
  const turns = schedule(state);
  const elapsed = effectiveElapsedSeconds(state, now);
  if (elapsed === null) return { index: 0, symbol: turns[0].symbol, inThinking: true, secondsLeft: turns[0].seconds, over: false, turns };
  let start = 0;
  for (const t of turns) {
    const thinkEnd = start + t.thinking;
    const end = thinkEnd + t.seconds;
    if (elapsed < thinkEnd) return { index: t.index, symbol: t.symbol, inThinking: true, secondsLeft: t.seconds, over: false, turns };
    if (elapsed < end) return { index: t.index, symbol: t.symbol, inThinking: false, secondsLeft: end - elapsed, over: false, turns };
    start = end;
  }
  return { index: turns.length, symbol: null, inThinking: false, secondsLeft: 0, over: true, turns };
}

/** All regulation turns have run out (by clock or by Finish Turn). */
function regulationOver(state, now = Date.now()) {
  const elapsed = effectiveElapsedSeconds(state, now);
  if (elapsed === null) return false;
  return elapsed >= turnEndSeconds(schedule(state), REGULATION_TURNS - 1);
}

/** Overtime is open and both extra turns have run out. */
function overtimeOver(state, now = Date.now()) {
  if (!overtimeStartedAt(state)) return false;
  return currentTurn(state, now).over;
}

/** Nothing left to play: regulation done and (if opened) overtime done. */
function gameOver(state, now = Date.now()) {
  return currentTurn(state, now).over;
}

/**
 * May `symbol` post a chat line right now? True inside their own chat
 * window, plus `graceSeconds` after it ends (a message sent on the buzzer
 * arrives after the boundary on the server's clock). Also true during the
 * opponent's THINKING prefix immediately after their own turn ended within
 * the grace — same thing, just expressed via the boundary.
 */
function mayChat(state, symbol, now = Date.now(), graceSeconds = 8) {
  const turns = schedule(state);
  const elapsed = effectiveElapsedSeconds(state, now);
  if (elapsed === null) return true;
  let start = 0;
  for (const t of turns) {
    const thinkEnd = start + t.thinking;
    const end = thinkEnd + t.seconds;
    if (t.symbol === symbol && elapsed >= thinkEnd && elapsed < end + graceSeconds) return true;
    start = end;
  }
  return false;
}

module.exports = {
  REGULATION_TURNS,
  OVERTIME_TURNS,
  INTRO_MS,
  symbolFor,
  thinkingSkipSymbol,
  schedule,
  turnEndSeconds,
  effectiveElapsedSeconds,
  currentTurn,
  regulationOver,
  overtimeOver,
  gameOver,
  mayChat,
};
