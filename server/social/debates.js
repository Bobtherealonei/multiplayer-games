// social/debates.js — one-on-one debates that start from an accepted
// challenge and are decided by the audience.
//
//   challengeDebates/{id}
//     id, challengeId, claim, quote, source, supportId, opposeId,
//     challengerId, challengedId, participantIds, status 'live' | 'finished',
//     rounds, turnSeconds, totalTurns, maxTurnLength,
//     turnIndex, turnUserId, turnEndsAt (ms), firstId,
//     votesSupport, votesOppose, result 'support' | 'oppose' | 'tie' | null,
//     winnerId, recordApplied, startedAt, endedAt
//   challengeDebates/{id}/turns/{00..}      index, round, userId, side, text, skipped, createdAt
//   challengeDebates/{id}/votes/{uid}       side, updatedAt
//   challengeDebates/{id}/audience/{id}     id, userId, text, createdAt
//
// Format: `rounds` rounds, the two debaters alternate, one message per turn,
// `turnSeconds` per turn. When the clock runs out the turn is skipped. After
// the last turn the debate closes and the side with more audience votes
// wins (a tie if equal); each debater's win–loss record is updated once.
//
// The clock is the server's. Every live debate has its next deadline in a
// Redis sorted set; each instance sweeps it once a second and takes a short
// lock per debate, so a skip happens exactly once however many instances
// run. A turn and the state change that follows it commit in one Firestore
// transaction, so a late message and a skip can never both land.
//
// Everyone watching sits in the room `debate:{id}`.
//
// Socket events:
//   debateOpen          { debateId }          → { debate, turns, myVote, viewers } and joins the room
//   debateClose         { debateId }
//   debateSay           { debateId, text }    (the debater whose turn it is)
//   debateVote          { debateId, side }    (anyone but the debaters, while live)
//   debateTyping        { debateId }          (no ack)
//   debateAudience      { debateId, cursor? } → { messages, next }
//   debateAudienceSend  { debateId, text }
//   profileDebates      { userId, cursor? }   → { items, next }
//   server → room: debateUpdate { debate, turn? }, debateVotes { debateId, support, oppose },
//                  debateViewers { debateId, count }, debateTyping { debateId, userId },
//                  debateAudienceMessage { debateId, message }

const core = require('./core');
const notifications = require('./notifications');

const DEBATES = 'challengeDebates';
const DEADLINES = 'duel:deadlines';
const TURN_GRACE_MS = 1500;
const SWEEP_MS = 1000;
const SWEEP_BATCH = 25;
const LOCK_MS = 4000;
const VIEWER_TTL_MS = 60 * 1000;
const VIEWER_HEARTBEAT_MS = 20 * 1000;
const AUDIENCE_PAGE = 50;
const LIST_PAGE = 20;
const TYPING_GAP_MS = 1000;

const col = () => core.requireDb().collection(DEBATES);
const ref = (id) => col().doc(id);
const turnRef = (id, index) => ref(id).collection('turns').doc(String(index).padStart(2, '0'));
const room = (id) => `debate:${id}`;
const activeKey = (uid) => `duel:active:${uid}`;
const viewersKey = (id) => `duel:viewers:${id}`;
const byId = () => core.FieldPath().documentId();

// ── Shapes ─────────────────────────────────────────────────────────────────

async function wire(debate) {
  const users = await core.getUsers([debate.supportId, debate.opposeId]);
  return {
    id: debate.id,
    challengeId: debate.challengeId || null,
    claim: debate.claim,
    quote: debate.quote || null,
    source: debate.source || null,
    support: users.get(debate.supportId),
    oppose: users.get(debate.opposeId),
    status: debate.status,
    rounds: debate.rounds,
    round: Math.min(Math.floor(debate.turnIndex / 2) + 1, debate.rounds),
    turnIndex: debate.turnIndex,
    totalTurns: debate.totalTurns,
    turnSeconds: debate.turnSeconds,
    maxTurnLength: debate.maxTurnLength,
    turnUserId: debate.turnUserId || null,
    turnEndsAt: debate.turnEndsAt || null,
    votesSupport: core.count(debate.votesSupport),
    votesOppose: core.count(debate.votesOppose),
    result: debate.result || null,
    winnerId: debate.winnerId || null,
    startedAt: debate.startedAt,
    endedAt: debate.endedAt || null,
    serverTime: Date.now()
  };
}

const wireTurn = (t) => ({
  index: t.index,
  round: t.round,
  userId: t.userId,
  side: t.side,
  text: t.text || null,
  skipped: t.skipped === true,
  createdAt: t.createdAt
});

async function load(debateId) {
  const snap = await ref(debateId).get();
  if (!snap.exists) throw core.clientError('not_found');
  return snap.data();
}

/** The live debate `uid` is in right now, if any. */
const activeDebateId = (uid) => core.redis.get(activeKey(uid));

// ── Engine ─────────────────────────────────────────────────────────────────

/** Starts the debate for an accepted challenge. `firstId` takes the first turn. */
async function create(challenge, { supportId, opposeId, firstId }) {
  const cfg = (await core.loadSocialConfig()).debate;
  const now = Date.now();
  const debate = {
    id: core.newId(now),
    challengeId: challenge.id,
    claim: challenge.claim,
    quote: challenge.quote || null,
    source: challenge.source || null,
    supportId,
    opposeId,
    challengerId: challenge.fromId,
    challengedId: challenge.toId,
    participantIds: [supportId, opposeId],
    status: 'live',
    rounds: cfg.rounds,
    turnSeconds: cfg.turnSeconds,
    totalTurns: cfg.rounds * 2,
    maxTurnLength: cfg.maxTurnLength,
    turnIndex: 0,
    firstId,
    turnUserId: firstId,
    turnEndsAt: now + cfg.turnSeconds * 1000,
    votesSupport: 0,
    votesOppose: 0,
    result: null,
    winnerId: null,
    recordApplied: false,
    startedAt: now,
    endedAt: null
  };
  // One live debate per person: both seats are claimed before it starts, so
  // two requests accepted at the same moment can't both go through.
  const ttl = Math.ceil(debate.totalTurns * (cfg.turnSeconds + 10)) + 3600;
  const claimed = [];
  try {
    for (const uid of debate.participantIds) {
      if (!(await core.redis.set(activeKey(uid), debate.id, 'EX', ttl, 'NX'))) {
        throw core.clientError(uid === challenge.toId ? 'busy' : 'challenger_busy');
      }
      claimed.push(uid);
    }
    await ref(debate.id).create(debate);
    await core.redis.zadd(DEADLINES, debate.turnEndsAt, debate.id);
  } catch (err) {
    await Promise.all(claimed.map((uid) => core.redis.del(activeKey(uid)))).catch(() => {});
    throw err;
  }
  return debate;
}

// Frees both debaters once a debate is over.
async function release(debate) {
  await core.redis.zrem(DEADLINES, debate.id);
  for (const uid of debate.participantIds) {
    if ((await core.redis.get(activeKey(uid))) === debate.id) await core.redis.del(activeKey(uid));
  }
}

// What changes on the debate when the current turn ends.
function afterTurnPatch(debate, now) {
  const turnIndex = debate.turnIndex + 1;
  if (turnIndex >= debate.totalTurns) {
    const support = core.count(debate.votesSupport);
    const oppose = core.count(debate.votesOppose);
    const result = support > oppose ? 'support' : oppose > support ? 'oppose' : 'tie';
    return {
      turnIndex,
      status: 'finished',
      turnUserId: null,
      turnEndsAt: null,
      result,
      winnerId: result === 'support' ? debate.supportId : result === 'oppose' ? debate.opposeId : null,
      endedAt: now
    };
  }
  return {
    turnIndex,
    turnUserId: debate.turnUserId === debate.supportId ? debate.opposeId : debate.supportId,
    turnEndsAt: now + debate.turnSeconds * 1000
  };
}

// Adds the result to both debaters' win–loss records, once.
async function applyRecord(debateId) {
  const db = core.requireDb();
  const uids = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(debateId));
    const d = snap.exists ? snap.data() : null;
    if (!d || d.status !== 'finished' || d.recordApplied) return [];
    const one = core.FieldValue().increment(1);
    for (const uid of [d.supportId, d.opposeId]) {
      const field = d.result === 'tie' ? 'debateDraws' : uid === d.winnerId ? 'debateWins' : 'debateLosses';
      tx.set(db.collection('users').doc(uid), { [field]: one }, { merge: true });
      tx.set(db.collection('publicProfiles').doc(uid), { [field]: one }, { merge: true });
    }
    tx.update(ref(debateId), { recordApplied: true });
    return [d.supportId, d.opposeId];
  });
  uids.forEach(core.forgetUser);
}

// Everything that follows a turn: the clock, the room, the notifications.
async function publishTurn(io, { debate, turn }) {
  const finished = debate.status === 'finished';
  if (finished) {
    await Promise.all([release(debate), applyRecord(debate.id)]);
  } else {
    await core.redis.zadd(DEADLINES, debate.turnEndsAt, debate.id);
  }

  const payload = { debate: await wire(debate), turn: wireTurn(turn) };
  if (io) io.to(room(debate.id)).emit('debateUpdate', payload);

  if (finished) {
    for (const uid of [debate.supportId, debate.opposeId]) {
      const other = uid === debate.supportId ? debate.opposeId : debate.supportId;
      const outcome = debate.result === 'tie' ? 'ended in a tie' : uid === debate.winnerId ? 'ended. You won' : 'ended. You lost';
      notifications.notify(io, uid, {
        type: 'debate_result',
        actorId: other,
        key: debate.id,
        debateId: debate.id,
        text: `Your debate ${outcome}.`
      });
    }
    require('./challenges').debateFinished(io, debate);
  } else {
    const other = debate.turnUserId === debate.supportId ? debate.opposeId : debate.supportId;
    notifications.notify(io, debate.turnUserId, {
      type: 'debate_turn',
      actorId: other,
      key: debate.id,
      debateId: debate.id,
      text: core.clip(debate.claim, 140)
    });
  }
  return payload;
}

/**
 * Ends the current turn: with `text` from the debater whose turn it is, or
 * as a skip once the clock has run out (`skip: true`). Returns null when a
 * skip was asked for but the turn isn't over yet.
 */
async function playTurn(io, debateId, { userId = null, text = null, skip = false }) {
  const db = core.requireDb();
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(debateId));
    const d = snap.exists ? snap.data() : null;
    if (!d) throw core.clientError('not_found');
    if (d.status !== 'live') throw core.clientError('debate_over');
    const now = Date.now();
    if (skip) {
      if (now < d.turnEndsAt + TURN_GRACE_MS) return null;
    } else {
      if (d.turnUserId !== userId) throw core.clientError('not_your_turn');
      if (now > d.turnEndsAt + TURN_GRACE_MS) throw core.clientError('turn_expired');
    }
    const turn = {
      index: d.turnIndex,
      round: Math.floor(d.turnIndex / 2) + 1,
      userId: d.turnUserId,
      side: d.turnUserId === d.supportId ? 'support' : 'oppose',
      text: skip ? null : text,
      skipped: skip,
      createdAt: now
    };
    const patch = afterTurnPatch(d, now);
    tx.create(turnRef(debateId, d.turnIndex), turn);
    tx.update(ref(debateId), patch);
    return { turn, debate: { ...d, ...patch } };
  });
  if (!outcome) return null;
  return publishTurn(io, outcome);
}

// A finished debate whose bookkeeping was interrupted (the instance went
// down between the last turn and the record update) is completed here.
async function finishUp(debateId) {
  try {
    const debate = await load(debateId);
    if (debate.status !== 'finished') return;
    await release(debate);
    if (!debate.recordApplied) await applyRecord(debateId);
  } catch (err) {
    console.warn('[debates] finishUp failed:', err.message);
  }
}

// Skips the turn if its clock has run out; otherwise puts the deadline back
// where Firestore says it is. Safe to call from anywhere, any number of times.
async function settleClock(io, debateId) {
  const lockKey = `duel:lock:${debateId}`;
  if (!(await core.redis.set(lockKey, '1', 'PX', LOCK_MS, 'NX'))) return;
  try {
    const skipped = await playTurn(io, debateId, { skip: true });
    if (!skipped) {
      const d = await load(debateId);
      await core.redis.zadd(DEADLINES, d.turnEndsAt, debateId);
    }
  } catch (err) {
    if (err && err.client) {
      // Already over (or gone): make sure nothing is left hanging.
      await core.redis.zrem(DEADLINES, debateId);
      if (err.code === 'debate_over') await finishUp(debateId);
    } else {
      console.error('[debates] settleClock failed:', err.message);
    }
  } finally {
    await core.redis.del(lockKey);
  }
}

let sweeper = null;

/** Starts the turn clock for this instance. */
function start(io) {
  if (sweeper) return;
  sweeper = setInterval(async () => {
    try {
      const due = await core.redis.zrangebyscore(DEADLINES, 0, Date.now() - TURN_GRACE_MS, 'LIMIT', 0, SWEEP_BATCH);
      await Promise.all(due.map((id) => settleClock(io, id)));
    } catch (err) {
      console.error('[debates] sweep failed:', err.message);
    }
  }, SWEEP_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

function stop() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

// ── Viewers ────────────────────────────────────────────────────────────────

async function viewerCount(debateId) {
  const now = Date.now();
  await core.redis.zremrangebyscore(viewersKey(debateId), 0, now - VIEWER_TTL_MS);
  return core.redis.zcard(viewersKey(debateId));
}

const debounceViewers = core.makeDebouncer(500);
const debounceVotes = core.makeDebouncer(400);

function pushViewers(io, debateId) {
  debounceViewers(debateId, async () => {
    io.to(room(debateId)).emit('debateViewers', { debateId, count: await viewerCount(debateId) });
  });
}

function pushVotes(io, debateId) {
  debounceVotes(debateId, async () => {
    const d = await load(debateId);
    io.to(room(debateId)).emit('debateVotes', {
      debateId,
      support: core.count(d.votesSupport),
      oppose: core.count(d.votesOppose)
    });
  });
}

// ── Socket events ──────────────────────────────────────────────────────────

function register({ io, socket, on, userId }) {
  const watching = new Map(); // debateId → { timer, debater, typedAt }

  const leave = async (debateId) => {
    const entry = watching.get(debateId);
    if (!entry) return;
    watching.delete(debateId);
    if (entry.timer) clearInterval(entry.timer);
    await socket.leave(room(debateId));
    if (!entry.debater) {
      await core.redis.zrem(viewersKey(debateId), userId);
      pushViewers(io, debateId);
    }
  };

  on('debateOpen', async (payload) => {
    const debateId = core.requireId(payload.debateId);
    let debate = await load(debateId);
    // The clock may have run out while nobody's instance was sweeping.
    if (debate.status === 'live' && Date.now() > debate.turnEndsAt + TURN_GRACE_MS + 3000) {
      await settleClock(io, debateId);
      debate = await load(debateId);
    }
    if (debate.status === 'finished' && !debate.recordApplied) await finishUp(debateId);

    const debater = debate.participantIds.includes(userId);
    const blocked = await core.blockedBy(userId);
    if (!debater && debate.participantIds.some((uid) => blocked.has(uid))) throw core.clientError('not_found');

    await leave(debateId);
    await socket.join(room(debateId));
    const entry = { debater, timer: null, typedAt: 0 };
    if (!debater && debate.status === 'live') {
      await core.redis.zadd(viewersKey(debateId), Date.now(), userId);
      await core.redis.pexpire(viewersKey(debateId), 6 * 60 * 60 * 1000);
      entry.timer = setInterval(() => {
        core.redis.zadd(viewersKey(debateId), Date.now(), userId).catch(() => {});
      }, VIEWER_HEARTBEAT_MS);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      pushViewers(io, debateId);
    }
    watching.set(debateId, entry);
    if (debater) notifications.markKeyRead(io, userId, 'debate_turn', debateId);

    const [turnSnap, voteSnap, viewers] = await Promise.all([
      ref(debateId).collection('turns').orderBy(byId(), 'asc').get(),
      debater ? null : ref(debateId).collection('votes').doc(userId).get(),
      viewerCount(debateId)
    ]);
    return {
      debate: await wire(debate),
      turns: turnSnap.docs.map((d) => wireTurn(d.data())),
      myVote: voteSnap && voteSnap.exists ? voteSnap.get('side') : null,
      viewers,
      isDebater: debater
    };
  });

  on('debateClose', async (payload) => {
    if (core.optionalId(payload.debateId)) await leave(payload.debateId);
    return {};
  });

  on('debateSay', async (payload) => {
    const debateId = core.requireId(payload.debateId);
    const debate = await load(debateId);
    if (!debate.participantIds.includes(userId)) throw core.clientError('not_allowed');
    const text = await core.validText(payload.text, { max: debate.maxTurnLength });
    const result = await playTurn(io, debateId, { userId, text });
    return result;
  });

  on('debateVote', async (payload) => {
    const debateId = core.requireId(payload.debateId);
    const side = payload.side === 'support' || payload.side === 'oppose' ? payload.side : null;
    if (!side) throw core.clientError('bad_request');
    await core.rateLimit('debateVote', userId, 60, 60 * 1000);

    const db = core.requireDb();
    const voteRef = ref(debateId).collection('votes').doc(userId);
    const counts = await db.runTransaction(async (tx) => {
      const [snap, voteSnap] = await tx.getAll(ref(debateId), voteRef);
      const d = snap.exists ? snap.data() : null;
      if (!d) throw core.clientError('not_found');
      if (d.participantIds.includes(userId)) throw core.clientError('debaters_cannot_vote');
      if (d.status !== 'live') throw core.clientError('debate_over');
      const previous = voteSnap.exists ? voteSnap.get('side') : null;
      let support = core.count(d.votesSupport);
      let oppose = core.count(d.votesOppose);
      if (previous !== side) {
        if (previous === 'support') support = Math.max(0, support - 1);
        if (previous === 'oppose') oppose = Math.max(0, oppose - 1);
        if (side === 'support') support += 1;
        else oppose += 1;
        tx.set(voteRef, { side, updatedAt: Date.now() });
        tx.update(ref(debateId), { votesSupport: support, votesOppose: oppose });
      }
      return { support, oppose };
    });
    pushVotes(io, debateId);
    return { myVote: side, ...counts };
  });

  // The debater on the clock is typing. Fire-and-forget, no ack.
  socket.on('debateTyping', (...args) => {
    const raw = Array.isArray(args[0]) ? args[0][0] : args[0];
    const debateId = raw && typeof raw.debateId === 'string' ? raw.debateId : null;
    const entry = debateId ? watching.get(debateId) : null;
    if (!entry || !entry.debater || Date.now() - entry.typedAt < TYPING_GAP_MS) return;
    entry.typedAt = Date.now();
    socket.to(room(debateId)).emit('debateTyping', { debateId, userId });
  });

  on('debateAudience', async (payload) => {
    const debateId = core.requireId(payload.debateId);
    // By the `id` field: document ids are only indexed ascending.
    let query = ref(debateId).collection('audience').orderBy('id', 'desc');
    const cursor = core.optionalId(payload.cursor);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.limit(AUDIENCE_PAGE).get();
    const blocked = await core.blockedBy(userId);
    const docs = snap.docs.map((d) => d.data() || {});
    const users = await core.getUsers(docs.map((d) => d.userId));
    return {
      messages: docs
        .filter((d) => !blocked.has(d.userId))
        .map((d) => ({ id: d.id, author: users.get(d.userId), text: d.text, createdAt: d.createdAt }))
        .reverse(),
      next: docs.length === AUDIENCE_PAGE ? docs[docs.length - 1].id : null
    };
  });

  on('debateAudienceSend', async (payload) => {
    const cfg = (await core.loadSocialConfig()).debate;
    const debateId = core.requireId(payload.debateId);
    const debate = await load(debateId);
    if (debate.participantIds.includes(userId)) throw core.clientError('debaters_cannot_chat');
    if (debate.status !== 'live') throw core.clientError('debate_over');
    const text = await core.validText(payload.text, { max: cfg.maxAudienceLength });
    const wait = await core.cooldown(`audience:${debateId}`, userId, cfg.audienceCooldownSeconds * 1000);
    if (wait > 0) throw core.clientError('rate_limited', { retryInMs: wait });

    const now = Date.now();
    const message = { id: core.newId(now), userId, text, createdAt: now };
    await ref(debateId).collection('audience').doc(message.id).create(message);
    const out = { id: message.id, author: await core.getUser(userId), text, createdAt: now };
    io.to(room(debateId)).emit('debateAudienceMessage', { debateId, message: out });
    return { message: out };
  });

  on('profileDebates', async (payload) => {
    const uid = core.requireUid(payload.userId);
    if ((await core.blockedBy(userId)).has(uid)) return { items: [], next: null };
    const cursor = core.optionalId(payload.cursor);
    const snaps = await Promise.all(
      ['supportId', 'opposeId'].map((field) => {
        let q = col().where(field, '==', uid).orderBy(byId(), 'desc');
        if (cursor) q = q.startAfter(cursor);
        return q.limit(LIST_PAGE).get();
      })
    );
    const all = snaps.flatMap((s) => s.docs.map((d) => d.data() || {})).sort((a, b) => (a.id < b.id ? 1 : -1));
    const docs = all.slice(0, LIST_PAGE);
    const more = all.length > LIST_PAGE || snaps.some((s) => s.size === LIST_PAGE);
    return {
      items: await Promise.all(docs.map(wire)),
      next: more && docs.length ? docs[docs.length - 1].id : null
    };
  });

  socket.on('disconnect', () => {
    [...watching.keys()].forEach((debateId) => {
      leave(debateId).catch(() => {});
    });
  });
}

module.exports = { register, start, stop, create, wire, load, activeDebateId, playTurn, settleClock, room };
