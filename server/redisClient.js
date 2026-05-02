// redisClient.js — single Redis connection for the game-server.
//
// All cluster-shared state (active games, matchmaking queues, judge cache,
// playerToGame mapping, etc.) lives in Redis so multiple game-server
// instances can share it. Without this, horizontal scaling on Render would
// silently break: each instance would have its own private state and
// players on different instances couldn't even see each other.
//
// We export THREE clients:
//   - client (general-purpose ops)
//   - pubClient + subClient (used by the Socket.IO redis adapter; per its
//     docs the pub/sub clients must be DEDICATED — you can't reuse `client`).
//
// Configuration:
//   REDIS_URL           — full URL e.g. redis://default:pass@host:6379
//                         OR rediss:// for TLS (Upstash uses TLS).
//   REDIS_KEY_PREFIX    — optional, defaults to "ts:" (so keys look like
//                         "ts:game:abc123" — handy if multiple apps share Redis).
//
// Failure modes:
//   - Missing REDIS_URL  → process.exit(1) on startup (loud, helpful).
//   - Connection drops   → ioredis auto-reconnects with exponential backoff;
//                          we log every state change so it's visible in
//                          Render logs.

const Redis = require('ioredis');

if (!process.env.REDIS_URL) {
  console.error([
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '[FATAL] REDIS_URL is not set.',
    '',
    'The game-server requires Redis for shared state across instances.',
    '',
    'Local dev:',
    '  docker compose up -d redis',
    '  export REDIS_URL=redis://localhost:6379',
    '',
    'Render:',
    '  Provision a Render Key/Value (Redis) service in the same workspace,',
    '  then add REDIS_URL to this service\'s environment variables.',
    '  See RENDER_DEPLOY.md for the full walkthrough.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n'));
  process.exit(1);
}

const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'ts:';

function makeClient(label) {
  const url = process.env.REDIS_URL;

  // ioredis options — keep timeouts conservative so a temporarily-flaky Redis
  // doesn't cascade into a bad request experience for users; the auto-retry
  // strategy below buys us up to ~minutes of resilience.
  const client = new Redis(url, {
    keyPrefix: KEY_PREFIX,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    // Exponential backoff capped at ~5s. ioredis retries forever by default.
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
    // Only retry these error types — others are likely client-side bugs and
    // should bubble up immediately rather than silently retry.
    reconnectOnError(err) {
      const msg = (err && err.message) || '';
      return /READONLY|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE/.test(msg);
    },
  });

  client.on('connect', () => {
    console.log(`[redis:${label}] connecting…`);
  });
  client.on('ready', () => {
    console.log(`[redis:${label}] ready`);
  });
  client.on('error', (err) => {
    console.error(`[redis:${label}] error:`, err.message);
  });
  client.on('end', () => {
    console.warn(`[redis:${label}] connection ended`);
  });
  client.on('reconnecting', (delayMs) => {
    console.log(`[redis:${label}] reconnecting in ${delayMs}ms`);
  });

  return client;
}

// Three independent connections. The Socket.IO redis adapter REQUIRES that
// pub/sub clients are not used for anything else (subscribe-mode connections
// can't issue arbitrary commands), so `client` stays separate.
const client = makeClient('client');
const pubClient = makeClient('pub');
const subClient = makeClient('sub');

// Convenience: expose the prefix so callers can build raw key names for
// pub/sub channels (which AREN'T auto-prefixed by ioredis).
function key(name) {
  return `${KEY_PREFIX}${name}`;
}

module.exports = {
  client,
  pubClient,
  subClient,
  key,
  KEY_PREFIX,
};
