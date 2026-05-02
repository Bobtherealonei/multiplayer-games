// gameStore.js — every read/write of cluster-shared game state goes through
// here. Centralising the Redis schema in one file keeps gameManager.js,
// matchmaking.js, etc. focused on game logic, and means the day we want to
// (say) change a game's TTL or swap in a different KV store, it's a one-file
// change.
//
// Redis schema (all keys auto-prefixed by ioredis with KEY_PREFIX = "ts:")
// ─────────────────────────────────────────────────────────────────────────
//   game:{gameId}                HASH   serialised game state (see below)
//   player-game:{userId}         STRING gameId currently assigned to userId
//   queue:{gameType}             ZSET   matchmaking queue, score = joinedAt
//   judge:{gameId}               STRING JSON judge result (TTL ~10 min)
//   judge-lock:{gameId}          STRING single-flight lock (TTL ~60s)
//
// Game hash fields are written/read as JSON so we can cheaply round-trip
// nested objects (matchRequests, etc.) without inventing a per-field schema.

const { client, key } = require('./redisClient');

// 1h TTL on a game key — if endGame somehow doesn't run (instance crash,
// SIGKILL, etc.), the orphaned record auto-evicts so it doesn't pollute
// Redis forever. Real games end within minutes.
const GAME_TTL_SECONDS = 60 * 60;

// 24h TTL on player→game so a wedged client that never sends `leaveGame`
// doesn't permanently block that user from joining new debates.
const PLAYER_GAME_TTL_SECONDS = 60 * 60 * 24;

// 10 minute cap on queue membership; anything stuck longer than this is a
// bug somewhere upstream and shouldn't keep matching against newcomers.
const QUEUE_STALE_MS = 10 * 60 * 1000;

// Atomic "pop two oldest" used by matchmaking. Either we get a pair or
// nothing — never split. Two instances racing for the same pair is the
// exact bug horizontal scaling introduces, and ZPOPMIN inside a single
// EVAL is the simplest way to make it impossible.
const POP_PAIR_LUA = `
local count = redis.call('ZCARD', KEYS[1])
if count < 2 then return {} end
return redis.call('ZPOPMIN', KEYS[1], 2)
`;

let popPairSha = null;
async function ensurePopPairLoaded() {
  if (popPairSha) return popPairSha;
  popPairSha = await client.script('LOAD', POP_PAIR_LUA);
  return popPairSha;
}

// ── Game state ──────────────────────────────────────────────────────────

async function saveGameState(gameId, state) {
  const flat = {};
  for (const [k, v] of Object.entries(state)) {
    flat[k] = JSON.stringify(v === undefined ? null : v);
  }
  const k = `game:${gameId}`;
  // HSET + EXPIRE in one round-trip. Pipeline is enough; we don't need MULTI
  // because writing two halves of "the same" game is acceptable — readers
  // tolerate missing fields and the EXPIRE just bumps the TTL forward.
  await client
    .pipeline()
    .hset(k, flat)
    .expire(k, GAME_TTL_SECONDS)
    .exec();
}

async function patchGameState(gameId, partial) {
  const flat = {};
  for (const [k, v] of Object.entries(partial)) {
    flat[k] = JSON.stringify(v === undefined ? null : v);
  }
  if (Object.keys(flat).length === 0) return;
  const k = `game:${gameId}`;
  await client
    .pipeline()
    .hset(k, flat)
    .expire(k, GAME_TTL_SECONDS)
    .exec();
}

async function loadGameState(gameId) {
  if (!gameId) return null;
  const raw = await client.hgetall(`game:${gameId}`);
  if (!raw || Object.keys(raw).length === 0) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = JSON.parse(v);
    } catch (_) {
      out[k] = v;
    }
  }
  return out;
}

async function deleteGame(gameId) {
  if (!gameId) return;
  await client.del(`game:${gameId}`);
}

// ── Player → game mapping ───────────────────────────────────────────────

async function setPlayerGame(userId, gameId) {
  if (!userId || !gameId) return;
  await client.set(`player-game:${userId}`, gameId, 'EX', PLAYER_GAME_TTL_SECONDS);
}

async function getPlayerGame(userId) {
  if (!userId) return null;
  return client.get(`player-game:${userId}`);
}

async function clearPlayerGame(userId) {
  if (!userId) return;
  await client.del(`player-game:${userId}`);
}

async function isPlayerInGame(userId) {
  return Boolean(await getPlayerGame(userId));
}

// ── Matchmaking queue ───────────────────────────────────────────────────

async function enqueuePlayer(gameType, userId) {
  if (!gameType || !userId) return;
  // Score = joined-at timestamp; ZPOPMIN later gives us the oldest waiter
  // first, which is the fair "first come, first served" semantic.
  await client.zadd(`queue:${gameType}`, Date.now(), userId);
}

async function removeFromAllQueues(userId) {
  if (!userId) return;
  // We don't track which queue a player is in (they should only ever be in
  // one anyway — see Matchmaking.addPlayer), so we sweep all of them. This
  // handles the rare case where the client switches gameType mid-search.
  // SCAN to avoid blocking on a huge keyspace.
  let cursor = '0';
  const pattern = `${require('./redisClient').KEY_PREFIX}queue:*`;
  do {
    const [next, batch] = await client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      100
    );
    cursor = next;
    if (batch.length > 0) {
      const pipe = client.pipeline();
      for (const fullKey of batch) {
        // ioredis auto-prefixes keys passed to commands, but SCAN returns
        // the FULL key (including prefix), so strip it before reusing.
        const stripped = fullKey.startsWith(require('./redisClient').KEY_PREFIX)
          ? fullKey.slice(require('./redisClient').KEY_PREFIX.length)
          : fullKey;
        pipe.zrem(stripped, userId);
      }
      await pipe.exec();
    }
  } while (cursor !== '0');
}

async function popPair(gameType) {
  const sha = await ensurePopPairLoaded();
  let res;
  try {
    res = await client.evalsha(sha, 1, key(`queue:${gameType}`));
  } catch (err) {
    // Redis evicts cached scripts on FLUSHALL / restart; reload and retry.
    if (/NOSCRIPT/i.test(err.message || '')) {
      popPairSha = null;
      const fresh = await ensurePopPairLoaded();
      res = await client.evalsha(fresh, 1, key(`queue:${gameType}`));
    } else {
      throw err;
    }
  }
  if (!Array.isArray(res) || res.length < 4) return null;
  // ZPOPMIN returns flat array: [member1, score1, member2, score2]
  const [u1, s1, u2, s2] = res;
  // Guard against ancient queue entries (a player who joined an hour ago
  // and we kept their entry through some bug). If either side is too stale
  // we drop them and tell the caller to retry — they'll re-enqueue if they
  // really are still searching.
  const now = Date.now();
  if (now - Number(s1) > QUEUE_STALE_MS) return { stale: u1 };
  if (now - Number(s2) > QUEUE_STALE_MS) return { stale: u2, returned: u1 };
  return { user1: u1, user2: u2 };
}

async function returnToQueue(gameType, userId, joinedAt) {
  if (!gameType || !userId) return;
  await client.zadd(`queue:${gameType}`, joinedAt || Date.now(), userId);
}

// ── Judge cache (single-flight) ─────────────────────────────────────────

const JUDGE_RESULT_TTL_SECONDS = 10 * 60;
const JUDGE_LOCK_TTL_SECONDS = 60;

async function getJudgeResult(gameId) {
  const raw = await client.get(`judge:${gameId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function setJudgeResult(gameId, result) {
  await client.set(
    `judge:${gameId}`,
    JSON.stringify(result),
    'EX',
    JUDGE_RESULT_TTL_SECONDS
  );
}

async function tryAcquireJudgeLock(gameId) {
  const res = await client.set(
    `judge-lock:${gameId}`,
    '1',
    'NX',
    'EX',
    JUDGE_LOCK_TTL_SECONDS
  );
  return res === 'OK';
}

async function releaseJudgeLock(gameId) {
  await client.del(`judge-lock:${gameId}`);
}

module.exports = {
  // game state
  saveGameState,
  patchGameState,
  loadGameState,
  deleteGame,
  // player ↔ game
  setPlayerGame,
  getPlayerGame,
  clearPlayerGame,
  isPlayerInGame,
  // matchmaking
  enqueuePlayer,
  removeFromAllQueues,
  popPair,
  returnToQueue,
  // judge
  getJudgeResult,
  setJudgeResult,
  tryAcquireJudgeLock,
  releaseJudgeLock,
};
