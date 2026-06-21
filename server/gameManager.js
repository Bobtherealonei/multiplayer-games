// gameManager.js — orchestrates the lifecycle of a debate game.
//
// Multi-instance design:
//   - All cluster-shared state lives in Redis (see gameStore.js for the
//     schema). The class instance you see below is just a thin facade that
//     loads-on-demand, mutates, then writes back.
//   - All outbound socket emits go through Socket.IO rooms instead of
//     direct socket references, so they get routed across instances by the
//     redis-adapter wired in index.js. The two rooms in play:
//         user:{userId}   — every connected socket for that user
//         game:{gameId}   — both players currently in the game
//   - pendingDisconnects is intentionally kept LOCAL to each instance.
//     When the timer fires we ask the redis-adapter for live sockets in
//     the user's room across the whole cluster (fetchSockets); if any are
//     present, we know they reconnected (possibly to a different instance)
//     and we bail. If the instance that scheduled the timer dies, the
//     1h game-key TTL eventually evicts the orphaned game — acceptable.

const TopicDebate = require('./topicDebate');
const {
  pickTrendingQuestion,
  recordSeen,
  LIVE_GAME_TYPES,
  LIVE_TOPIC_META,
  TRENDING_GAME_TYPE,
  FALLBACK_QUESTIONS
} = TopicDebate;
const { getDb, getAdmin } = require('./firestoreClient');
const store = require('./gameStore');
const { markQuestionDebated } = require('./questionHistory');
const rewards = require('./rewards');

const RECONNECT_GRACE_MS = 12000;

function userRoom(userId) { return `user:${userId}`; }
function gameRoom(gameId) { return `game:${gameId}`; }

class GameManager {
  constructor(io) {
    this.io = io;
    this.gameFactories = new Map();
    // userId -> setTimeout handle. LOCAL ONLY, see file header.
    this.pendingDisconnects = new Map();
    // Every "game type" the iOS client knows is a debate topic. The legacy
    // 'religion' key is the Trending in the USA slot.
    this.registerGameType('religion', TopicDebate);
    this.registerGameType('aiFuture', TopicDebate);
    this.registerGameType('currentPolitics', TopicDebate);
    this.registerGameType('custom', TopicDebate);
    this.registerGameType('sportsDebate', TopicDebate);
  }

  registerGameType(gameType, GameClass) {
    this.gameFactories.set(gameType, GameClass);
  }

  // Hydrate a game class instance from its serialised Redis form.
  _hydrate(state) {
    if (!state || !state.gameType) return null;
    const GameClass = this.gameFactories.get(state.gameType);
    if (!GameClass) return null;
    const game = new GameClass();
    game.gameType = state.gameType;
    game.gameId = state.gameId;
    game.fromState(state);
    return game;
  }

  // Both players in the game must be in the `game:{gameId}` room for emits
  // to reach them. We re-add each user's currently-connected sockets across
  // the cluster — fetchSockets() goes through the redis-adapter so it sees
  // sockets on other instances too.
  async _joinPlayersToGameRoom(gameId, player1Id, player2Id) {
    for (const uid of [player1Id, player2Id]) {
      try {
        const sockets = await this.io.in(userRoom(uid)).fetchSockets();
        for (const s of sockets) {
          await s.join(gameRoom(gameId));
        }
      } catch (err) {
        console.error(`[gameManager] failed to join ${uid} to ${gameRoom(gameId)}:`, err.message);
      }
    }
  }

  // Counter-part: pull both players out of the game room when it ends.
  async _removePlayersFromGameRoom(gameId, player1Id, player2Id) {
    for (const uid of [player1Id, player2Id]) {
      try {
        const sockets = await this.io.in(userRoom(uid)).fetchSockets();
        for (const s of sockets) {
          await s.leave(gameRoom(gameId));
        }
      } catch (err) {
        console.error(`[gameManager] failed to remove ${uid} from ${gameRoom(gameId)}:`, err.message);
      }
    }
  }

  // Caller (matchmaking) has already popped two userIds out of the queue.
  // We don't need socket references — we emit through rooms.
  //
  // matchPayload (position-based topic debates) carries the question chosen on
  // the client before matchmaking plus each player's Support/Oppose stance:
  //   { question, questionId, topicTitle, positions: { [uid]: 'support'|'oppose' } }
  // When present we use that question verbatim and skip the async live-news
  // resolution below.
  async createGame(player1Id, player2Id, gameType, customPayload = null, matchPayload = null) {
    const GameClass = this.gameFactories.get(gameType);
    if (!GameClass) throw new Error(`Unknown game type: ${gameType}`);

    const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const game = new GameClass();
    game.gameId = gameId;
    game.gameType = gameType;
    if (gameType === 'custom' && customPayload) {
      game.customDebatePayload = customPayload;
    }
    if (matchPayload) {
      game.preChosenMatch = matchPayload;
    }

    const initResult = game.createGame([
      { id: player1Id },
      { id: player2Id }
    ]);

    // Persist initial state + bind both players to this game.
    await store.saveGameState(gameId, game.serialize());
    await Promise.all([
      store.setPlayerGame(player1Id, gameId),
      store.setPlayerGame(player2Id, gameId)
    ]);

    await this._joinPlayersToGameRoom(gameId, player1Id, player2Id);

    // Each player's Support/Oppose stance (position-based topic debates).
    const p1Position = game.player1Position || null;
    const p2Position = game.player2Position || null;

    // Dispatch the per-user `gameFound` events. Each player needs to know
    // their own symbol AND the opponent's id, which is asymmetric, so we
    // emit twice — once per user room.
    this.io.to(userRoom(player1Id)).emit('gameFound', {
      gameId,
      symbol: initResult.player1.symbol,
      opponentUid: player2Id,
      opponent: player2Id, // legacy
      gameType,
      position: p1Position,
      opponentPosition: p2Position,
      question: game.question
    });
    this.io.to(userRoom(player2Id)).emit('gameFound', {
      gameId,
      symbol: initResult.player2.symbol,
      opponentUid: player1Id,
      opponent: player1Id, // legacy
      gameType,
      position: p2Position,
      opponentPosition: p1Position,
      question: game.question
    });

    await this.sendGameState(gameId, game);

    console.log(`Game created: ${gameId} between ${player1Id} and ${player2Id}`);

    if (matchPayload) {
      this._writeDebateDocument(gameId, gameType, player1Id, player2Id, matchPayload).catch((err) => {
        console.error('[gameManager] writeDebateDocument failed:', err.message);
      });
    }

    if (matchPayload && matchPayload.questionId) {
      const db = getDb();
      if (db) {
        recordSeen(db, [player1Id, player2Id], matchPayload.questionId).catch((err) => {
          console.warn('[gameManager] recordSeen (preChosen) failed:', err.message);
        });
        markQuestionDebated(player1Id, matchPayload.questionId).catch(() => {});
        markQuestionDebated(player2Id, matchPayload.questionId).catch(() => {});
      }
    } else if (!matchPayload && LIVE_GAME_TYPES.has(gameType) && gameType !== 'custom') {
      // Live-news topic with no pre-chosen question? Kick off the Firestore
      // fetch and broadcast the real question once it's resolved.
      this._resolveTrendingQuestion(gameId, gameType, player1Id, player2Id).catch((err) => {
        console.error('[gameManager] _resolveTrendingQuestion failed:', err.message);
      });
    }

    return gameId;
  }

  async _writeDebateDocument(gameId, gameType, player1Id, player2Id, matchPayload) {
    const db = getDb();
    if (!db || !matchPayload) return;

    const admin = getAdmin();
    const FieldValue = admin.firestore.FieldValue;
    const positions = matchPayload.positions || {};

    let supportUserId = null;
    let opposeUserId = null;
    for (const [uid, pos] of Object.entries(positions)) {
      if (pos === 'support') supportUserId = uid;
      if (pos === 'oppose') opposeUserId = uid;
    }

    await db.collection('debates').doc(gameId).set({
      gameId,
      questionId: matchPayload.questionId || null,
      questionText: matchPayload.question || '',
      categoryId: matchPayload.categoryId || gameType,
      topicTitle: matchPayload.topicTitle || null,
      supportUserId,
      opposeUserId,
      player1Id,
      player2Id,
      createdAt: FieldValue.serverTimestamp(),
      status: 'active'
    });
    console.log(`[gameManager] debate doc written gameId=${gameId} questionId=${matchPayload.questionId}`);
  }

  async _resolveTrendingQuestion(gameId, gameType, player1Id, player2Id) {
    let chosen;
    try {
      chosen = await pickTrendingQuestion([player1Id, player2Id], gameType);
    } catch (err) {
      console.error('[gameManager] pickTrendingQuestion failed:', err.message);
      // Pick the right per-topic fallback bank if we know it, else the legacy
      // trendingUSA one (FALLBACK_QUESTIONS).
      const meta = LIVE_TOPIC_META[gameType];
      const bank = (meta && meta.fallbacks) || FALLBACK_QUESTIONS;
      chosen = {
        question: bank[Math.floor(Math.random() * bank.length)],
        questionId: null
      };
    }

    // Game might have ended while we were waiting on the network round-trip.
    const state = await store.loadGameState(gameId);
    if (!state) return;

    await store.patchGameState(gameId, { question: chosen.question });

    const db = getDb();
    if (db && chosen.questionId) {
      try {
        await recordSeen(db, [player1Id, player2Id], chosen.questionId);
      } catch (err) {
        console.warn('[gameManager] recordSeen failed:', err.message);
      }
    }

    // Broadcast updated state to both players via the game room.
    const updated = await store.loadGameState(gameId);
    if (!updated) return;
    const game = this._hydrate(updated);
    if (game) await this.sendGameState(gameId, game);
  }

  async handleMove(playerId, data) {
    const gameId = await store.getPlayerGame(playerId);
    if (!gameId) return;
    const state = await store.loadGameState(gameId);
    if (!state) return;
    const game = this._hydrate(state);
    if (!game) return;

    const result = game.makeMove(playerId, data);
    if (result.success) {
      await store.saveGameState(gameId, game.serialize());
      await this.sendGameState(gameId, game);
    } else {
      // moveError is per-user feedback, not a broadcast.
      this.io.to(userRoom(playerId)).emit('moveError', { error: result.error });
    }
  }

  // Chat: relay only to the OTHER player. Game room minus sender.
  async handleChat(playerId, payload) {
    const gameId = payload?.gameId || (await store.getPlayerGame(playerId));
    if (!gameId) return;
    const state = await store.loadGameState(gameId);
    if (!state) return;

    const otherId = state.player1Id === playerId ? state.player2Id : state.player1Id;
    if (!otherId) return;

    // First message marks the debate as "started" — only started debates pay
    // out tokens / count as a forfeit if abandoned (see rewards.js).
    if (!state.startedAt) {
      await store.patchGameState(gameId, { startedAt: Date.now() });
    }

    this.io.to(userRoom(otherId)).emit('chatMessage', {
      message: payload?.message,
      sender: payload?.sender,
      symbol: payload?.symbol,
      gameId,
      playerId
    });
  }

  // Caller may already have a hydrated game instance (saves a Redis read).
  async sendGameState(gameId, gameInstance) {
    let game = gameInstance;
    if (!game) {
      const state = await store.loadGameState(gameId);
      if (!state) return;
      game = this._hydrate(state);
      if (!game) return;
    }
    const payload = {
      player1Symbol: game.player1Symbol,
      player2Symbol: game.player2Symbol,
      gameType: game.gameType,
      ...game.getState()
    };
    this.io.to(gameRoom(gameId)).emit('gameState', payload);
  }

  // Tear down a game everywhere: Redis state, room membership, pending
  // disconnect timers on THIS instance. Cross-instance pending timers
  // self-heal — when they fire, they'll see no game in Redis and bail.
  async endGame(gameId) {
    const state = await store.loadGameState(gameId);
    if (!state) return;
    const { player1Id, player2Id } = state;

    for (const uid of [player1Id, player2Id]) {
      const t = this.pendingDisconnects.get(uid);
      if (t) {
        clearTimeout(t);
        this.pendingDisconnects.delete(uid);
      }
    }

    await Promise.all([
      store.clearPlayerGame(player1Id),
      store.clearPlayerGame(player2Id),
      store.deleteGame(gameId)
    ]);

    await this._removePlayersFromGameRoom(gameId, player1Id, player2Id);
    console.log(`Game ended: ${gameId}`);
  }

  async handleLeaveGame(playerId, message = 'Player has disconnected') {
    const gameId = await store.getPlayerGame(playerId);
    if (!gameId) return;
    // If the debate had already started, quitting counts as a loss for the
    // quitter and a win for the opponent. Process BEFORE teardown so the game
    // state (player IDs, startedAt) is still in Redis. Idempotent.
    try {
      await rewards.processForfeit(gameId, playerId);
    } catch (err) {
      console.error('[gameManager] forfeit (leave) failed:', err.message);
    }
    this.io.to(gameRoom(gameId)).emit('playerLeft', { message, gameId });
    await this.endGame(gameId);
  }

  // Schedule, not execute, the "opponent disconnected" notification. Local
  // setTimeout — the listener for the user's room across the cluster is
  // checked when the timer fires.
  async handleDisconnect(playerId) {
    const gameId = await store.getPlayerGame(playerId);
    if (!gameId) return;

    const existing = this.pendingDisconnects.get(playerId);
    if (existing) clearTimeout(existing);

    const handle = setTimeout(async () => {
      this.pendingDisconnects.delete(playerId);
      try {
        // If the game has already been torn down (peer hit Leave, TTL
        // expiry, etc.), nothing to do.
        const state = await store.loadGameState(gameId);
        if (!state) return;

        // Cross-instance reconnection check. If the user has any live
        // socket anywhere in the cluster, treat them as reconnected.
        const sockets = await this.io.in(userRoom(playerId)).fetchSockets();
        if (sockets.length > 0) return;

        // Treat a real disconnect (no reconnection within the grace window)
        // of a started debate as a forfeit. Idempotent via debateResults.
        try {
          await rewards.processForfeit(gameId, playerId);
        } catch (err) {
          console.error('[gameManager] forfeit (disconnect) failed:', err.message);
        }

        const otherId = state.player1Id === playerId ? state.player2Id : state.player1Id;
        if (otherId) {
          this.io.to(userRoom(otherId)).emit('opponentDisconnected', {
            message: 'Player has disconnected',
            gameId
          });
        }
        await this.endGame(gameId);
      } catch (err) {
        console.error('[gameManager] disconnect timer failed:', err.message);
      }
    }, RECONNECT_GRACE_MS);

    this.pendingDisconnects.set(playerId, handle);
  }

  // Called from io.on('connection') when a fresh socket arrives carrying a
  // userId that already has an active game. Re-joins the right rooms and
  // pushes the current state. Crucially, we ALSO clear the local pending
  // disconnect timer if there is one — and broadcast a "user is back"
  // signal so other instances clear theirs too.
  async reattachSocket(userId, socket) {
    const gameId = await store.getPlayerGame(userId);
    if (!gameId) return false;
    const state = await store.loadGameState(gameId);
    if (!state) {
      // Stale player→game mapping (game was deleted but the mapping wasn't).
      // Clean up so we don't keep tripping over it.
      await store.clearPlayerGame(userId);
      return false;
    }

    await socket.join(gameRoom(gameId));

    const pending = this.pendingDisconnects.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.pendingDisconnects.delete(userId);
    }

    // Push current game state to just this socket so the freshly-loaded
    // client doesn't have a stale view.
    const game = this._hydrate(state);
    if (game) {
      const symbol =
        userId === game.player1Id ? game.player1Symbol : game.player2Symbol;
      const opponentUid =
        userId === game.player1Id ? game.player2Id : game.player1Id;
      socket.emit('gameFound', {
        gameId,
        symbol,
        opponentUid,
        opponent: opponentUid,
        gameType: game.gameType
      });
      socket.emit('gameState', {
        player1Symbol: game.player1Symbol,
        player2Symbol: game.player2Symbol,
        gameType: game.gameType,
        ...game.getState()
      });
    }
    return true;
  }

  async isPlayerInGame(playerId) {
    return store.isPlayerInGame(playerId);
  }
}

module.exports = GameManager;
