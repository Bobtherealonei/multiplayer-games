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
//   disconnect:{userId}          STRING JSON { gameId, at } — last mid-game drop (TTL 10 min)
//   ended-notice:{userId}        STRING JSON — "your game ended while away" (TTL 10 min)
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

// 5 minute cap on queue membership for multi-question matchmaking.
const QUEUE_STALE_MS = 5 * 60 * 1000;
const MAX_USER_QUEUE_ENTRIES = 5;
const USER_ENTRIES_TTL_SECONDS = 600;

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

// Atomic chat append with caps. Two messages landing within one Redis
// round-trip (a buzzer-beater and the opponent's opener, or a fast double
// send) used to race load→patch and overwrite each other — and the judge
// now grades THIS log, so every line has to stick.
// ARGV: symbol, text, maxPerTurn, maxTotal, nowMs, ttlSeconds, turnIndex
// Returns 'ok' | 'too_many' | 'missing'
const APPEND_CHAT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'missing' end
local raw = redis.call('HGET', KEYS[1], 'chatLog')
local log = {}
if raw and raw ~= '' and raw ~= 'null' then log = cjson.decode(raw) end
local n = #log
if n >= tonumber(ARGV[4]) then return 'too_many' end
local turn = tonumber(ARGV[7])
local inTurn = 0
for i = n, 1, -1 do
  if type(log[i]) == 'table' and log[i].symbol == ARGV[1] and log[i].turn == turn then inTurn = inTurn + 1 end
end
if inTurn >= tonumber(ARGV[3]) then return 'too_many' end
log[n + 1] = { symbol = ARGV[1], text = ARGV[2], turn = turn }
redis.call('HSET', KEYS[1], 'chatLog', cjson.encode(log))
local started = redis.call('HGET', KEYS[1], 'startedAt')
if not started or started == '' or started == 'null' then
  redis.call('HSET', KEYS[1], 'startedAt', ARGV[5])
end
redis.call('EXPIRE', KEYS[1], ARGV[6])
return 'ok'
`;

let appendChatSha = null;
async function ensureAppendChatLoaded() {
  if (appendChatSha) return appendChatSha;
  appendChatSha = await client.script('LOAD', APPEND_CHAT_LUA);
  return appendChatSha;
}

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

/**
 * Atomically append a chat line, enforcing per-turn and total caps inside
 * Redis. Resolves 'ok' | 'too_many' | 'missing'.
 */
async function appendChat(gameId, symbol, text, { maxPerTurn, maxTotal, turnIndex } = {}) {
  const sha = await ensureAppendChatLoaded();
  const args = [`game:${gameId}`, symbol, text, String(maxPerTurn ?? 8), String(maxTotal ?? 120), String(Date.now()), String(GAME_TTL_SECONDS), String(Number.isInteger(turnIndex) ? turnIndex : -1)];
  try {
    return await client.evalsha(sha, 1, ...args);
  } catch (err) {
    if (String(err?.message || '').includes('NOSCRIPT')) {
      appendChatSha = null;
      return client.eval(APPEND_CHAT_LUA, 1, ...args);
    }
    throw err;
  }
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

// ── Disconnect tracking (cluster-safe reconnect grace) ──────────────────
//
//   disconnect:{userId}    STRING JSON { gameId, at }   TTL 10 min
//
// Written when a socket for a mid-game user drops, deleted when ANY socket
// for that user reattaches. The grace timer is a local setTimeout on the
// instance that saw the drop; a reconnect that lands on a different
// instance can't cancel it. So when a timer fires it reads this key and
// only forfeits if the user's MOST RECENT drop is at least the grace period
// old — otherwise it re-arms for the remainder. Without this, a player whose
// connection flaps across instances gets forfeited on a stale countdown.
const DISCONNECT_TTL_SECONDS = 10 * 60;

async function markPlayerDisconnected(userId, gameId, at = Date.now()) {
  if (!userId || !gameId) return;
  await client.set(
    `disconnect:${userId}`,
    JSON.stringify({ gameId, at }),
    'EX',
    DISCONNECT_TTL_SECONDS
  );
}

async function getPlayerDisconnect(userId) {
  if (!userId) return null;
  const raw = await client.get(`disconnect:${userId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.at === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

async function clearPlayerDisconnect(userId) {
  if (!userId) return;
  await client.del(`disconnect:${userId}`);
}

// ── "Your game ended while you were away" notice ─────────────────────────
//
//   ended-notice:{userId}  STRING JSON { gameId, reason, kind, message, at }  TTL 10 min
//
// Set when a game ends for a player who has no live socket (forfeited by
// the grace timer, or their opponent quit while they were backgrounded).
// Consumed on their next connection so the client can leave the dead
// debate screen instead of sitting in it alone.
const ENDED_NOTICE_TTL_SECONDS = 10 * 60;

async function setEndedNotice(userId, notice) {
  if (!userId || !notice || !notice.gameId) return;
  await client.set(
    `ended-notice:${userId}`,
    JSON.stringify({ ...notice, at: Date.now() }),
    'EX',
    ENDED_NOTICE_TTL_SECONDS
  );
}

// Read-and-delete: a notice is delivered at most once.
async function takeEndedNotice(userId) {
  if (!userId) return null;
  const k = `ended-notice:${userId}`;
  const raw = await client.get(k);
  if (!raw) return null;
  await client.del(k);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
  // Both entries were popped; the one we keep must be handed back to the
  // caller to re-enqueue, whichever side was stale.
  if (now - Number(s1) > QUEUE_STALE_MS) return { stale: u1, returned: u2 };
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
    topicTitle: ctx.topicTitle || '',
    questionExpiresAt: ctx.questionExpiresAt || ''
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

async function clearMatchContext(userId, questionId = null) {
  if (!userId) return;
  if (questionId) {
    await client.del(`mmctx:${userId}:${questionId}`);
    return;
  }
  // Legacy single-context key
  await client.del(`mmctx:${userId}`);
}

async function setMatchContextForQuestion(userId, questionId, ctx) {
  if (!userId || !questionId || !ctx) return;
  const payload = {
    gameType: ctx.gameType || '',
    questionId: String(questionId),
    question: ctx.question || '',
    position: ctx.position || 'support',
    topicTitle: ctx.topicTitle || '',
    joinedAt: String(ctx.joinedAt || Date.now())
  };
  const k = `mmctx:${userId}:${questionId}`;
  await client.hset(k, payload);
  await client.expire(k, USER_ENTRIES_TTL_SECONDS);
}

async function getMatchContextForQuestion(userId, questionId) {
  if (!userId || !questionId) return null;
  const raw = await client.hgetall(`mmctx:${userId}:${questionId}`);
  if (!raw || Object.keys(raw).length === 0) return null;
  return raw;
}

async function getUserQueueQuestionIds(userId) {
  if (!userId) return [];
  return client.zrange(`userentries:${userId}`, 0, -1);
}

async function countUserQueueEntries(userId) {
  if (!userId) return 0;
  return client.zcard(`userentries:${userId}`);
}

async function addUserQueueEntry(userId, questionId, joinedAt = Date.now()) {
  if (!userId || !questionId) return;
  await client.zadd(`userentries:${userId}`, joinedAt, String(questionId));
  await client.expire(`userentries:${userId}`, USER_ENTRIES_TTL_SECONDS);
}

async function removeUserQueueEntry(userId, questionId) {
  if (!userId || !questionId) return;
  await client.pipeline()
    .zrem(`userentries:${userId}`, String(questionId))
    .del(`mmctx:${userId}:${questionId}`)
    .exec();
}

async function clearAllUserQueueEntries(userId) {
  if (!userId) return;
  const ids = await getUserQueueQuestionIds(userId);
  if (ids.length) {
    const pipe = client.pipeline();
    for (const qid of ids) {
      pipe.del(`mmctx:${userId}:${qid}`);
    }
    pipe.del(`userentries:${userId}`);
    await pipe.exec();
  } else {
    await client.del(`userentries:${userId}`);
  }
}

/**
 * Drop queue entries older than QUEUE_STALE_MS and remove from Redis queues.
 * Returns removed question IDs.
 */
async function expireStaleUserEntries(userId) {
  if (!userId) return [];
  const withScores = await client.zrange(`userentries:${userId}`, 0, -1, 'WITHSCORES');
  if (!withScores.length) return [];

  const now = Date.now();
  const removed = [];
  for (let i = 0; i < withScores.length; i += 2) {
    const questionId = withScores[i];
    const joinedAt = Number(withScores[i + 1]);
    if (now - joinedAt <= QUEUE_STALE_MS) continue;

    const ctx = await getMatchContextForQuestion(userId, questionId);
    if (ctx && ctx.gameType && ctx.position) {
      const suffix = `${ctx.gameType}::q::${questionId}::${ctx.position}`;
      await removeFromQueue(suffix, userId);
    }
    await removeUserQueueEntry(userId, questionId);
    removed.push(questionId);
  }
  return removed;
}

const QUEUE_META_TTL_SECONDS = 600;

async function setQueueMeta(queueKey, meta) {
  if (!queueKey || !meta) return;
  const payload = {
    customDebateId: meta.customDebateId || '',
    question: meta.question || '',
    topicTitle: meta.topicTitle || 'Custom',
    // Redis hashes store strings; topicDebate accepts 'true'. Dropping this
    // field here was why friendly challenges kept paying ranked rewards.
    friendly: meta.friendly === true || meta.friendly === 'true' ? 'true' : 'false'
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

// ── Pre-debate lobby ────────────────────────────────────────────────────

const PLAYER_LOBBY_TTL_SECONDS = 120;
const AVOID_PAIR_TTL_SECONDS = 30 * 60;

async function setPlayerLobby(userId, lobbyId) {
  if (!userId || !lobbyId) return;
  await client.set(`player-lobby:${userId}`, lobbyId, 'EX', PLAYER_LOBBY_TTL_SECONDS);
}

async function getPlayerLobby(userId) {
  if (!userId) return null;
  return client.get(`player-lobby:${userId}`);
}

async function clearPlayerLobby(userId) {
  if (!userId) return;
  await client.del(`player-lobby:${userId}`);
}

async function isPlayerInLobby(userId) {
  return Boolean(await getPlayerLobby(userId));
}

function avoidPairKey(userA, userB) {
  const sorted = [String(userA), String(userB)].sort();
  return `avoidpair:${sorted[0]}:${sorted[1]}`;
}

async function addAvoidPair(userA, userB) {
  if (!userA || !userB) return;
  await client.set(avoidPairKey(userA, userB), '1', 'EX', AVOID_PAIR_TTL_SECONDS);
}

async function shouldAvoidPair(userA, userB) {
  if (!userA || !userB) return false;
  const val = await client.get(avoidPairKey(userA, userB));
  return val === '1';
}

async function setLobbySelection(lobbyId, userId, position) {
  if (!lobbyId || !userId) return false;
  const k = `lobbysel:${lobbyId}`;
  const existing = await client.hget(k, userId);
  if (existing) return false;
  await client.hset(k, userId, position);
  await client.expire(k, PLAYER_LOBBY_TTL_SECONDS);
  return true;
}

async function getLobbySelections(lobbyId) {
  if (!lobbyId) return {};
  return client.hgetall(`lobbysel:${lobbyId}`);
}

async function clearLobbySelections(lobbyId) {
  if (!lobbyId) return;
  await client.del(`lobbysel:${lobbyId}`);
}

async function incrementLobbyAbandon(userId) {
  if (!userId) return 0;
  const k = `lobby-abandon:${userId}`;
  const n = await client.incr(k);
  await client.expire(k, 3600);
  return n;
}

async function getLobbyAbandonCount(userId) {
  if (!userId) return 0;
  const n = await client.get(`lobby-abandon:${userId}`);
  return Number(n) || 0;
}

async function clearLobbyAbandonCount(userId) {
  if (!userId) return;
  await client.del(`lobby-abandon:${userId}`);
}

// ── Player online (matchmaking liveness) ────────────────────────────────
// fetchSockets() across the redis-adapter can be flaky right after connect;
// we also mark users online in Redis so pairing never silently drops waiters.

const PLAYER_ONLINE_TTL_SECONDS = 180;

async function setPlayerOnline(userId) {
  if (!userId) return;
  await client.set(`player-online:${userId}`, '1', 'EX', PLAYER_ONLINE_TTL_SECONDS);
}

async function touchPlayerOnline(userId) {
  if (!userId) return;
  await client.expire(`player-online:${userId}`, PLAYER_ONLINE_TTL_SECONDS);
}

async function clearPlayerOnline(userId) {
  if (!userId) return;
  await client.del(`player-online:${userId}`);
}

async function isPlayerOnline(userId) {
  if (!userId) return false;
  const val = await client.get(`player-online:${userId}`);
  return val === '1';
}

// ── Judge cache (single-flight) ─────────────────────────────────────────

// Verdicts live as long as the game state: a player who idles on the
// results screen and then leaves must still be treated as post-debate, not
// as a mid-debate quitter.
const JUDGE_RESULT_TTL_SECONDS = GAME_TTL_SECONDS;
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

// ── AI reply claims ─────────────────────────────────────────────────────
// One AI reply per (game, turn), across instances and across the human-like
// delay the side-select stand-in waits before answering. Cleared on failure
// so a retry request can try again.
const AI_REPLY_CLAIM_TTL_SECONDS = 120;

async function tryClaimAIReply(gameId, turnIndex) {
  const res = await client.set(
    `ai-reply:${gameId}:${turnIndex}`,
    '1',
    'NX',
    'EX',
    AI_REPLY_CLAIM_TTL_SECONDS
  );
  return res === 'OK';
}

async function releaseAIReplyClaim(gameId, turnIndex) {
  await client.del(`ai-reply:${gameId}:${turnIndex}`);
}

// ── Client capabilities ─────────────────────────────────────────────────
// What the user's current app build supports, recorded at socket connect
// (from the handshake) so game creation on ANY instance can read it.
// `serverTurns`: the client takes its per-turn chat length from the game
// state instead of a hardcoded 45 s. Legacy builds send nothing → defaults.

const CLIENT_CAPS_TTL_SECONDS = 24 * 60 * 60;

async function setClientCaps(userId, caps) {
  await client.set(`client-caps:${userId}`, JSON.stringify(caps || {}), 'EX', CLIENT_CAPS_TTL_SECONDS);
}

async function getClientCaps(userId) {
  const raw = await client.get(`client-caps:${userId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// True while some instance is computing the verdict for this game — i.e. the
// debate is over and the results screen is up, even though no verdict is
// cached yet.
async function isJudgeInProgress(gameId) {
  const n = await client.exists(`judge-lock:${gameId}`);
  return n === 1;
}

module.exports = {
  // game state
  saveGameState,
  patchGameState,
  appendChat,
  loadGameState,
  deleteGame,
  // player ↔ game
  setPlayerGame,
  getPlayerGame,
  clearPlayerGame,
  isPlayerInGame,
  // disconnect grace / ended notices
  markPlayerDisconnected,
  getPlayerDisconnect,
  clearPlayerDisconnect,
  setEndedNotice,
  takeEndedNotice,
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
  setMatchContextForQuestion,
  getMatchContextForQuestion,
  getUserQueueQuestionIds,
  countUserQueueEntries,
  addUserQueueEntry,
  removeUserQueueEntry,
  clearAllUserQueueEntries,
  expireStaleUserEntries,
  MAX_USER_QUEUE_ENTRIES,
  QUEUE_STALE_MS,
  setPlayerLobby,
  getPlayerLobby,
  clearPlayerLobby,
  isPlayerInLobby,
  addAvoidPair,
  shouldAvoidPair,
  setLobbySelection,
  getLobbySelections,
  clearLobbySelections,
  incrementLobbyAbandon,
  getLobbyAbandonCount,
  clearLobbyAbandonCount,
  setPlayerOnline,
  touchPlayerOnline,
  clearPlayerOnline,
  isPlayerOnline,
  // judge
  getJudgeResult,
  setJudgeResult,
  tryAcquireJudgeLock,
  releaseJudgeLock,
  tryClaimAIReply,
  releaseAIReplyClaim,
  isJudgeInProgress,
  // client capabilities
  setClientCaps,
  getClientCaps,
};
