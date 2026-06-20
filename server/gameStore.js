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

// Atomic "pop one from each of two queues" — used by position-based
// matchmaking to pair a Support player with an Oppose player. Either we get
// one from each side or nothing, so two instances can never grab the same
// player. Returns [supportUser, supportScore, opposeUser, opposeScore].
const POP_OPPOSING_LUA = `
local s = redis.call('ZCARD', KEYS[1])
local o = redis.call('ZCARD', KEYS[2])
if s < 1 or o < 1 then return {} end
local a = redis.call('ZPOPMIN', KEYS[1], 1)
local b = redis.call('ZPOPMIN', KEYS[2], 1)
return {a[1], a[2], b[1], b[2]}
`;

let popPairSha = null;
async function ensurePopPairLoaded() {
  if (popPairSha) return popPairSha;
  popPairSha = await client.script('LOAD', POP_PAIR_LUA);
  return popPairSha;
}

let popOpposingSha = null;
async function ensurePopOpposingLoaded() {
  if (popOpposingSha) return popOpposingSha;
  popOpposingSha = await client.script('LOAD', POP_OPPOSING_LUA);
  return popOpposingSha;
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
  // NB: pass the UNPREFIXED key here. ioredis auto-prefixes KEYS[] args of
  // EVAL/EVALSHA the same way it does for plain commands, so calling
  // `key(...)` ourselves would double-prefix and read from the wrong slot
  // (silently returning an empty queue, which manifests as matchmaking
  // never pairing anyone — see git blame on this comment).
  const queueKey = `queue:${gameType}`;
  let res;
  try {
    res = await client.evalsha(sha, 1, queueKey);
  } catch (err) {
    // Redis evicts cached scripts on FLUSHALL / restart; reload and retry.
    if (/NOSCRIPT/i.test(err.message || '')) {
      popPairSha = null;
      const fresh = await ensurePopPairLoaded();
      res = await client.evalsha(fresh, 1, queueKey);
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

// Pop one player from each of two opposing queues (Support vs Oppose).
// Both queueKey args are the UNPREFIXED suffix (e.g.
// "aiFuture::q::abc123::support"); ioredis auto-prefixes the KEYS[] args of
// EVALSHA just like plain commands, so we pass `queue:<suffix>` directly —
// see the popPair() note about double-prefixing.
async function popOpposingPair(supportSuffix, opposeSuffix) {
  const sha = await ensurePopOpposingLoaded();
  const supportKey = `queue:${supportSuffix}`;
  const opposeKey = `queue:${opposeSuffix}`;
  let res;
  try {
    res = await client.evalsha(sha, 2, supportKey, opposeKey);
  } catch (err) {
    if (/NOSCRIPT/i.test(err.message || '')) {
      popOpposingSha = null;
      const fresh = await ensurePopOpposingLoaded();
      res = await client.evalsha(fresh, 2, supportKey, opposeKey);
    } else {
      throw err;
    }
  }
  if (!Array.isArray(res) || res.length < 4) return null;
  const [supportUser, supportScore, opposeUser, opposeScore] = res;
  const now = Date.now();
  // Drop ancient entries the same way popPair does; tell caller which side(s)
  // were stale so it can leave the survivor in place.
  const supportStale = now - Number(supportScore) > QUEUE_STALE_MS;
  const opposeStale = now - Number(opposeScore) > QUEUE_STALE_MS;
  if (supportStale || opposeStale) {
    return {
      stale: true,
      supportUser: supportStale ? null : supportUser,
      opposeUser: opposeStale ? null : opposeUser,
      supportSuffix,
      opposeSuffix
    };
  }
  return { supportUser, opposeUser };
}

async function returnToQueue(queueKey, userId, joinedAt) {
  if (!queueKey || !userId) return;
  await client.zadd(`queue:${queueKey}`, joinedAt || Date.now(), userId);
}

async function removeFromQueue(queueKey, userId) {
  if (!queueKey || !userId) return;
  await client.zrem(`queue:${queueKey}`, userId);
}

// ── Per-player matchmaking context ──────────────────────────────────────
// Stores the question/position a searching player chose so that when they're
// popped out of an opposing queue we know which question + side to assign.

const MATCH_CONTEXT_TTL_SECONDS = 600;

async function setMatchContext(userId, ctx) {
  if (!userId || !ctx) return;
  const payload = {
    gameType: ctx.gameType || '',
    questionId: ctx.questionId || '',
    question: ctx.question || '',
    position: ctx.position || 'support',
    topicTitle: ctx.topicTitle || ''
  };
  await client.hset(`mmctx:${userId}`, payload);
  await client.expire(`mmctx:${userId}`, MATCH_CONTEXT_TTL_SECONDS);
}

async function getMatchContext(userId) {
  if (!userId) return null;
  const raw = await client.hgetall(`mmctx:${userId}`);
  if (!raw || Object.keys(raw).length === 0) return null;
  return raw;
}

async function clearMatchContext(userId) {
  if (!userId) return;
  await client.del(`mmctx:${userId}`);
}

const QUEUE_META_TTL_SECONDS = 600;

async function setQueueMeta(queueKey, meta) {
  if (!queueKey || !meta) return;
  const payload = {
    customDebateId: meta.customDebateId || '',
    question: meta.question || '',
    topicTitle: meta.topicTitle || 'Custom'
  };
  await client.hset(`queueMeta:${queueKey}`, payload);
  await client.expire(`queueMeta:${queueKey}`, QUEUE_META_TTL_SECONDS);
}

async function getQueueMeta(queueKey) {
  if (!queueKey) return null;
  const raw = await client.hgetall(`queueMeta:${queueKey}`);
  if (!raw || !raw.question) return null;
  return raw;
}

async function clearQueueMeta(queueKey) {
  if (!queueKey) return;
  await client.del(`queueMeta:${queueKey}`);
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
  removeFromQueue,
  popPair,
  popOpposingPair,
  returnToQueue,
  setQueueMeta,
  getQueueMeta,
  clearQueueMeta,
  setMatchContext,
  getMatchContext,
  clearMatchContext,
  // judge
  getJudgeResult,
  setJudgeResult,
  tryAcquireJudgeLock,
  releaseJudgeLock,
};
