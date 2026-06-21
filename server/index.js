// index.js — game-server entry point.
//
// Multi-instance ready: every piece of cross-instance state lives in Redis,
// and Socket.IO emits are routed cluster-wide via @socket.io/redis-adapter.
// See RENDER_DEPLOY.md for the deploy walkthrough and gameStore.js for the
// Redis schema.

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

// Touching redisClient first means a missing REDIS_URL fails fast with a
// helpful error before we set up any HTTP listeners.
const { pubClient, subClient } = require('./redisClient');

const GameManager = require('./gameManager');
const Matchmaking = require('./matchmaking');
const DebateLobbyManager = require('./debateLobby');
const store = require('./gameStore');
const factCheckRoute = require('./factcheck');
const coachRoute = require('./coach');
const judgeRoute = require('./judge');
const nextQuestionRoute = require('./nextQuestion');
const rewardsRoute = require('./rewards');
const shopRoute = require('./shop');
const shopRotation = require('./shopRotation');

const app = express();

// HTTP middleware (used by /factcheck, /coach, /judge — Socket.IO has its
// own CORS).
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Websocket-only — no HTTP-polling fallback.
  //
  // Render does not support sticky sessions; with multiple instances behind
  // its load balancer, polling requests for the same Socket.IO session can
  // land on different instances and the session lookup fails ("Session ID
  // unknown"). Forcing websocket gives every client one long-lived
  // connection that doesn't bounce between instances. The redis-adapter
  // installed below routes emits across instances over Redis pub/sub.
  // The iOS client must match this with .forceWebsockets(true).
  transports: ['websocket'],
  allowUpgrades: false
});

// The redis-adapter routes broadcasts (io.to(...).emit, etc.) and operations
// like fetchSockets() across every instance that's connected to the same
// Redis. Without this, two players on different instances couldn't see
// each other's chat messages.
io.adapter(createAdapter(pubClient, subClient));
console.log('[socket.io] redis adapter installed');

const gameManager = new GameManager(io);
const lobbyManager = new DebateLobbyManager(io, gameManager, null);
const matchmaking = new Matchmaking(gameManager, io, lobbyManager);
lobbyManager.matchmaking = matchmaking;

// Health check (also used by Render's healthcheck pings).
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// LLM proxy routes (keys live only in Render env vars).
app.use(factCheckRoute.makeRouter());
app.use(coachRoute.makeRouter());
app.use(judgeRoute.makeRouter());
app.use(nextQuestionRoute.makeRouter());
app.use(rewardsRoute.makeRouter());
app.use(shopRoute.makeRouter());

// Seed the cosmetic catalog (if empty) and keep the daily/weekly Spark Shop
// rotations fresh. Deterministic generation means every instance agrees.
shopRotation.scheduleRotations();

io.on('connection', async (socket) => {
  // userId is supplied by the iOS client through socket.handshake. Falling
  // back to socket.id keeps things working in dev (e.g. a curl-based
  // sanity check) but in production every real client sends a Firebase uid.
  const userId =
    socket.handshake.query?.userId ||
    socket.handshake.auth?.userId ||
    socket.id;
  socket.userId = userId;

  console.log(`Player connected: socket.id=${socket.id}, userId=${userId}`);

  // Every socket joins this user's personal room. All cross-instance
  // emits to a specific user go through `io.to(userRoom(uid)).emit(...)`,
  // which is delivered by the redis-adapter to whichever instance owns
  // the live socket.
  await socket.join(`user:${userId}`);
  await store.setPlayerOnline(userId);

  // If this user already has an active game (e.g. they had a transient
  // blip and Socket.IO auto-reconnected, possibly to a DIFFERENT instance
  // than before), reattach this fresh socket to the game room and cancel
  // the grace-period timer so the other player never sees a "disconnected"
  // notice.
  try {
    if (await gameManager.reattachSocket(userId, socket)) {
      console.log(`  ↳ reattached to active game for userId=${userId}`);
    } else if (await lobbyManager.reattachLobby(userId, socket)) {
      console.log(`  ↳ reattached to active lobby for userId=${userId}`);
    }
  } catch (err) {
    console.error('[connection] reattach failed:', err.message);
  }

  socket.on('findMatch', async (data) => {
    const payload = Array.isArray(data) ? data[0] : data;
    const gameType = payload?.gameType || 'religion'; // Default to "Trending in the USA"
    try {
      await store.touchPlayerOnline(userId);
      await matchmaking.addPlayer(socket, gameType, userId, payload || {});
    } catch (err) {
      console.error('[findMatch] failed:', err.message);
      socket.emit('matchmakingStatus', { status: 'error', error: 'Internal error' });
    }
  });

  socket.on('submitLobbySelection', async (data) => {
    const payload = Array.isArray(data) ? data[0] : data;
    const lobbyId = payload?.lobbyId;
    const position = payload?.position;
    if (!lobbyId || !position) {
      socket.emit('lobbyError', { error: 'lobbyId and position are required' });
      return;
    }
    try {
      const result = await lobbyManager.submitSelection(userId, lobbyId, position);
      if (!result.ok) {
        socket.emit('lobbyError', { lobbyId, error: result.error });
      }
    } catch (err) {
      console.error('[submitLobbySelection] failed:', err.message);
      socket.emit('lobbyError', { error: 'Internal error' });
    }
  });

  socket.on('makeMove', async (data) => {
    const moveData = Array.isArray(data) ? data[0] : data;
    console.log('Received makeMove from', userId, '(socket:', socket.id, ') data:', JSON.stringify(moveData));
    try {
      await gameManager.handleMove(userId, moveData);
    } catch (err) {
      console.error('[makeMove] failed:', err.message);
    }
  });

  socket.on('chatMessage', async (data) => {
    const payload = Array.isArray(data) ? data[0] : data;
    try {
      await gameManager.handleChat(userId, payload);
    } catch (err) {
      console.error('[chatMessage] failed:', err.message);
    }
  });

  socket.on('leaveGame', async (data) => {
    const payload = Array.isArray(data) ? data[0] : data;
    const reason = payload?.reason || 'Player has disconnected';
    console.log(`[leaveGame] userId=${userId} reason=${reason} gameId=${payload?.gameId || 'none'}`);
    try {
      await matchmaking.removePlayer(userId);
      await gameManager.handleLeaveGame(userId, reason);
    } catch (err) {
      console.error('[leaveGame] failed:', err.message);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`Player disconnected: userId=${userId}, socket.id=${socket.id}`);
    try {
      // Best-effort: drop them from the matchmaking queue so we don't
      // try to match against a phantom userId. handleDisconnect schedules
      // the grace-period timer; if the user reconnects within that
      // window (possibly to another instance), the timer is cancelled.
      await store.clearPlayerOnline(userId);
      await matchmaking.removePlayer(userId);
      await gameManager.handleDisconnect(userId);
    } catch (err) {
      console.error('[disconnect] failed:', err.message);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
