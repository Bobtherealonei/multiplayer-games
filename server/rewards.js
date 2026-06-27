// rewards.js — authoritative debate-result reward processing.
//
// SECURITY MODEL
//   The client can never award itself tokens. This module runs on the server
//   (Firebase Admin SDK, bypasses security rules) and is the only writer of
//   users/{uid}.rankTokens / sparkTokens. The HTTP route verifies a Firebase
//   ID token so the caller can't impersonate another user, and confirms the
//   caller actually participated in the game it's claiming a result for.
//
//   Idempotency: every game's reward is processed exactly once, guarded by a
//   debateResults/{gameId} document inside a Firestore transaction — so the
//   two players both POSTing, the result screen reloading, retries, etc. can
//   never double-award.
//
// REWARD RULES (from the product spec)
//   Rank tokens (competitive trophies — can't be spent):
//     win  +10 | loss -8 (floor 0) | draw 0
//   Spark tokens (spendable):
//     win: +2 completion, +8 win bonus, daily bonuses (first of day +3, 3rd of day +4)
//     loss: 0
//     draw: +1 total (no rank tokens, no daily bonuses)
//   A debate with no official result (never started / abandoned pre-start) is
//   skipped entirely.

const express = require('express');
const store = require('./gameStore');
const { getDb, getAdmin, getAuth } = require('./firestoreClient');
const { dayKey } = require('./timeUtil');

const RANK_WIN = 10;
const RANK_LOSS = 8;
const SPARK_COMPLETION = 2;
const SPARK_WIN_BONUS = 8;
const SPARK_DRAW = 1;
const SPARK_FIRST_OF_DAY = 3;
const SPARK_THREE_IN_DAY = 4;

function defaultUserTokens(data) {
  return {
    rankTokens: Number.isFinite(data?.rankTokens) ? data.rankTokens : 100,
    sparkTokens: Number.isFinite(data?.sparkTokens) ? data.sparkTokens : 0,
    lastDebateDay: data?.lastDebateDay || null,
    debatesToday: Number.isFinite(data?.debatesToday) ? data.debatesToday : 0
  };
}

// Compute one player's deltas + the history entries describing them.
function computePlayerRewards(role, current, todayKey, debateId) {
  // role: 'win' | 'loss' | 'draw'
  let rankDelta = 0;
  let sparkDelta = 0;
  const history = [];

  // ── Rank ──
  if (role === 'win') rankDelta = RANK_WIN;
  else if (role === 'loss') rankDelta = -RANK_LOSS;
  // draw: no rank/trophy change

  const newRank = Math.max(0, current.rankTokens + rankDelta);
  // Record the ACTUAL applied change (floor at 0 may shrink a loss).
  const appliedRank = newRank - current.rankTokens;
  if (appliedRank !== 0) {
    history.push({
      tokenType: 'rank',
      amount: appliedRank,
      reason: role === 'win' ? 'debate_win' : 'debate_loss',
      debateId
    });
  }

  // ── Spark ──
  if (role === 'win') {
    sparkDelta += SPARK_COMPLETION;
    history.push({ tokenType: 'spark', amount: SPARK_COMPLETION, reason: 'debate_completion', debateId });
    sparkDelta += SPARK_WIN_BONUS;
    history.push({ tokenType: 'spark', amount: SPARK_WIN_BONUS, reason: 'debate_win_bonus', debateId });
  } else if (role === 'draw') {
    sparkDelta += SPARK_DRAW;
    history.push({ tokenType: 'spark', amount: SPARK_DRAW, reason: 'debate_draw', debateId });
  }
  // loss: no spark tokens

  // Daily bonuses — wins only.
  const isFirstToday = current.lastDebateDay !== todayKey;
  const newCount = isFirstToday ? 1 : current.debatesToday + 1;
  if (role === 'win') {
    if (isFirstToday) {
      sparkDelta += SPARK_FIRST_OF_DAY;
      history.push({ tokenType: 'spark', amount: SPARK_FIRST_OF_DAY, reason: 'first_debate_of_day', debateId });
    }
    if (newCount === 3) {
      sparkDelta += SPARK_THREE_IN_DAY;
      history.push({ tokenType: 'spark', amount: SPARK_THREE_IN_DAY, reason: 'three_debates_in_day', debateId });
    }
  }

  const newSpark = current.sparkTokens + sparkDelta;

  return {
    newRank,
    newSpark,
    rankApplied: appliedRank,
    sparkApplied: sparkDelta,
    newDebatesToday: newCount,
    history
  };
}

// Core transaction. outcome = { result: 'win'|'draw', winnerId, loserId } for
// a decisive game, or { result: 'draw', drawA, drawB } for a tie.
async function processResult({ gameId, gameType, outcome, reason }) {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');
  const admin = getAdmin();
  const FieldValue = admin.firestore.FieldValue;

  const resultRef = db.collection('debateResults').doc(gameId);
  const todayKey = dayKey();

  // Map outcome -> per-uid role.
  const isDraw = outcome.result === 'draw';
  const roleByUid = isDraw
    ? { [outcome.drawA]: 'draw', [outcome.drawB]: 'draw' }
    : { [outcome.winnerId]: 'win', [outcome.loserId]: 'loss' };
  const uids = Object.keys(roleByUid);
  if (uids.length !== 2) throw new Error('processResult needs exactly two players');

  const userRefs = uids.map((uid) => db.collection('users').doc(uid));

  return db.runTransaction(async (tx) => {
    const existing = await tx.get(resultRef);
    if (existing.exists && existing.data().rewardsProcessed === true) {
      return { alreadyProcessed: true, ...existing.data() };
    }

    const snaps = await Promise.all(userRefs.map((ref) => tx.get(ref)));
    const perUser = {};
    for (let i = 0; i < uids.length; i++) {
      const uid = uids[i];
      const current = defaultUserTokens(snaps[i].exists ? snaps[i].data() : {});
      perUser[uid] = computePlayerRewards(roleByUid[uid], current, todayKey, gameId);
    }

    // Apply balances + daily counters.
    for (let i = 0; i < uids.length; i++) {
      const uid = uids[i];
      const r = perUser[uid];
      tx.set(
        userRefs[i],
        {
          rankTokens: r.newRank,
          sparkTokens: r.newSpark,
          lastDebateDay: todayKey,
          debatesToday: r.newDebatesToday
        },
        { merge: true }
      );
      // One tokenHistory entry per change.
      for (const h of r.history) {
        const histRef = userRefs[i].collection('tokenHistory').doc();
        tx.set(histRef, {
          tokenType: h.tokenType,
          amount: h.amount,
          reason: h.reason,
          debateId: h.debateId,
          timestamp: FieldValue.serverTimestamp()
        });
      }
    }

    const winnerId = isDraw ? null : outcome.winnerId;
    const loserId = isDraw ? null : outcome.loserId;
    tx.set(resultRef, {
      rewardsProcessed: true,
      gameId,
      gameType: gameType || null,
      result: outcome.result,
      winnerId,
      loserId,
      reason: reason || 'completed',
      completedAt: FieldValue.serverTimestamp()
    });

    return {
      alreadyProcessed: false,
      result: outcome.result,
      winnerId,
      loserId,
      balances: Object.fromEntries(
        uids.map((uid) => [uid, { rankTokens: perUser[uid].newRank, sparkTokens: perUser[uid].newSpark }])
      ),
      applied: Object.fromEntries(
        uids.map((uid) => [uid, { rank: perUser[uid].rankApplied, spark: perUser[uid].sparkApplied }])
      )
    };
  });
}

// Translate the judge verdict (X=player1/P1, O=player2/P2) into an outcome.
function outcomeFromJudge(state, judge) {
  const p1 = state.player1Id;
  const p2 = state.player2Id;
  if (!judge || !judge.winner) return null;
  if (judge.winner === 'tie') {
    return { result: 'draw', drawA: p1, drawB: p2 };
  }
  if (judge.winner === 'X') {
    return { result: 'win', winnerId: p1, loserId: p2 };
  }
  if (judge.winner === 'O') {
    return { result: 'win', winnerId: p2, loserId: p1 };
  }
  return null;
}

// Forfeit: a player quit a debate that had already started -> loss for the
// quitter, win for the opponent. Called from gameManager BEFORE the game is
// torn down. Safe to call more than once (idempotent via debateResults).
async function processForfeit(gameId, quitterId) {
  const db = getDb();
  if (!db) return null;
  const state = await store.loadGameState(gameId);
  if (!state) return null;
  // Only started debates count (spec: ignore abandons before it begins).
  if (!state.startedAt) return null;
  const { player1Id, player2Id, gameType } = state;
  if (!player1Id || !player2Id) return null;
  if (quitterId !== player1Id && quitterId !== player2Id) return null;

  // If the debate already reached an official verdict (judge ran), finalize
  // THAT result instead of a forfeit — quitting the result screen shouldn't
  // turn a win into a loss. processResult is idempotent regardless.
  const judge = await store.getJudgeResult(gameId);
  const judgedOutcome = judge ? outcomeFromJudge(state, judge) : null;
  const outcome = judgedOutcome || { result: 'win', winnerId: quitterId === player1Id ? player2Id : player1Id, loserId: quitterId };

  try {
    return await processResult({
      gameId,
      gameType,
      outcome,
      reason: judgedOutcome ? 'completed' : 'forfeit'
    });
  } catch (err) {
    console.error('[rewards] processForfeit failed:', err.message);
    return null;
  }
}

function makeRouter() {
  const router = express.Router();

  router.post('/debate-result', async (req, res) => {
    const { gameId, idToken } = req.body || {};
    if (!gameId || typeof gameId !== 'string') {
      return res.status(400).json({ error: 'gameId is required' });
    }

    // Verify the caller.
    const auth = getAuth();
    if (!auth) return res.status(500).json({ error: 'Auth unavailable' });
    let uid;
    try {
      const decoded = await auth.verifyIdToken(String(idToken || ''));
      uid = decoded.uid;
    } catch (err) {
      return res.status(401).json({ error: 'Invalid auth token' });
    }

    const state = await store.loadGameState(gameId);
    if (!state) {
      return res.status(404).json({ error: 'Game not found' });
    }
    // Caller must be a participant.
    if (uid !== state.player1Id && uid !== state.player2Id) {
      return res.status(403).json({ error: 'Not a participant in this game' });
    }
    // No official result if the debate never started.
    if (!state.startedAt) {
      return res.json({ status: 'noResult' });
    }

    const judge = await store.getJudgeResult(gameId);
    if (!judge) {
      // Judge hasn't finished yet — client should retry shortly.
      return res.json({ status: 'pending' });
    }
    const outcome = outcomeFromJudge(state, judge);
    if (!outcome) return res.json({ status: 'noResult' });

    try {
      const summary = await processResult({
        gameId,
        gameType: state.gameType,
        outcome,
        reason: 'completed'
      });
      // Return only the caller's view.
      const myBalances = summary.balances ? summary.balances[uid] : null;
      const myApplied = summary.applied ? summary.applied[uid] : null;
      return res.json({
        status: summary.alreadyProcessed ? 'alreadyProcessed' : 'processed',
        result: summary.result,
        winnerId: summary.winnerId,
        loserId: summary.loserId,
        balances: myBalances,
        applied: myApplied
      });
    } catch (err) {
      console.error('[debate-result] failed:', err.message);
      return res.status(500).json({ error: 'Failed to process result' });
    }
  });

  return router;
}

module.exports = { makeRouter, processForfeit, processResult };
