// matchmaking.js — player-first matchmaking.
//
// Topic debates: FIFO queue per category → random Support/Oppose → gameFound.

const store = require('./gameStore');

function userRoom(userId) { return `user:${userId}`; }

class Matchmaking {
  constructor(gameManager, io, lobbyManager) {
    this.gameManager = gameManager;
    this.io = io;
    this.lobbyManager = lobbyManager;
  }

  async addPlayer(socket, gameType, userId, options = {}) {
    if (!gameType) {
      socket.emit('matchmakingStatus', { status: 'error', error: 'gameType is required' });
      return;
    }

    if (await this.gameManager.isPlayerInGame(userId)) {
      socket.emit('matchmakingStatus', { status: 'alreadyInGame' });
      return;
    }

    if (await store.isPlayerInLobby(userId)) {
      const reattached = await this.lobbyManager.reattachLobby(userId, socket);
      if (reattached) {
        socket.emit('matchmakingStatus', { status: 'alreadyInLobby' });
        return;
      }
      // Stale lobby mapping (Firestore doc gone / lobby finished) — clear and re-queue.
      await store.clearPlayerLobby(userId);
    }

    // Instant topic matching no longer uses selection lobbies, so the old
    // abandon penalty just strands real users. Clear any stale strikes.
    await store.clearLobbyAbandonCount(userId);

    // ── Custom debates: unchanged ──────────────────────────────────────────
    if (gameType === 'custom') {
      await store.removeFromAllQueues(userId);
      await store.clearAllUserQueueEntries(userId);

      if (!options.customDebateId || !options.question) {
        socket.emit('matchmakingStatus', {
          status: 'error',
          error: 'customDebateId and question are required for custom debates'
        });
        return;
      }
      const queueKey = `custom:${options.customDebateId}`;
      await store.setQueueMeta(queueKey, {
        customDebateId: options.customDebateId,
        question: options.question,
        topicTitle: options.topicTitle || 'Custom'
      });
      await store.enqueuePlayer(queueKey, userId);
      socket.emit('matchmakingStatus', { status: 'searching', gameType: 'custom' });
      await this.tryMatchmaking(queueKey, 'custom');
      return;
    }

    // ── Topic debates: general category queue ────────────────────────────────
    await store.removeFromAllQueues(userId);
    await store.clearAllUserQueueEntries(userId);
    await store.setPlayerOnline(userId);
    await store.enqueuePlayer(gameType, userId);

    console.log(`[matchmaking] enqueue user=${userId} category=${gameType}`);
    socket.emit('matchmakingStatus', { status: 'searching', gameType });

    await this.tryTopicMatchmaking(gameType);
  }

  _scheduleTopicRetry(gameType, delayMs = 400) {
    setTimeout(() => {
      this.tryTopicMatchmaking(gameType).catch((err) => {
        console.error('[matchmaking] topic retry failed:', err.message);
      });
    }, delayMs);
  }

  async requeuePlayer(userId, gameType) {
    if (!userId || !gameType || gameType === 'custom') return;
    if (await this.lobbyManager.isPlayerBusy(userId)) return;

    await store.setPlayerOnline(userId);
    await store.enqueuePlayer(gameType, userId);
    this.io.to(userRoom(userId)).emit('matchmakingStatus', { status: 'searching', gameType });
    await this.tryTopicMatchmaking(gameType);
  }

  async tryTopicMatchmaking(gameType) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const pair = await store.popPair(gameType);
      if (!pair) return;

      if (pair.stale) {
        if (pair.returned) {
          await store.returnToQueue(gameType, pair.returned, Date.now());
        }
        continue;
      }

      const { user1, user2 } = pair;

      if (await store.shouldAvoidPair(user1, user2)) {
        await store.returnToQueue(gameType, user1, Date.now());
        await store.returnToQueue(gameType, user2, Date.now() + 1);
        continue;
      }

      const live = await Promise.all([
        this._hasLiveSocket(user1),
        this._hasLiveSocket(user2)
      ]);
      if (!live[0] && !live[1]) {
        // Never drop both waiters — re-queue and retry (fetchSockets can lie).
        await store.returnToQueue(gameType, user1, Date.now());
        await store.returnToQueue(gameType, user2, Date.now() + 1);
        this._scheduleTopicRetry(gameType);
        return;
      }
      if (!live[0]) {
        await store.returnToQueue(gameType, user2, Date.now());
        this._scheduleTopicRetry(gameType);
        return;
      }
      if (!live[1]) {
        await store.returnToQueue(gameType, user1, Date.now());
        this._scheduleTopicRetry(gameType);
        return;
      }

      if (await store.isPlayerInLobby(user1) || await store.isPlayerInLobby(user2)) {
        await store.returnToQueue(gameType, user1, Date.now());
        await store.returnToQueue(gameType, user2, Date.now() + 1);
        continue;
      }

      try {
        await this.lobbyManager.createLobby(user1, user2, gameType);
        return;
      } catch (err) {
        console.error('[matchmaking] createLobby failed:', err.message);
        await Promise.all([
          store.returnToQueue(gameType, user1, Date.now()),
          store.returnToQueue(gameType, user2, Date.now() + 1)
        ]);
        this._scheduleTopicRetry(gameType, 600);
        return;
      }
    }
  }

  async removePlayer(userId) {
    await this.lobbyManager.leaveLobby(userId);
    await store.removeFromAllQueues(userId);
    await store.clearAllUserQueueEntries(userId);
  }

  async tryMatchmaking(queueKey, gameType = Matchmaking.gameTypeFromQueueKey(queueKey)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pair = await store.popPair(queueKey);
      if (!pair) return;

      if (pair.stale) {
        if (pair.returned) {
          await store.returnToQueue(queueKey, pair.returned, Date.now());
        }
        continue;
      }

      const { user1, user2 } = pair;

      const live = await Promise.all([
        this._hasLiveSocket(user1),
        this._hasLiveSocket(user2)
      ]);
      if (!live[0] && !live[1]) continue;
      if (!live[0]) {
        await store.returnToQueue(queueKey, user2, Date.now());
        continue;
      }
      if (!live[1]) {
        await store.returnToQueue(queueKey, user1, Date.now());
        continue;
      }

      try {
        let customPayload = null;
        if (gameType === 'custom') {
          customPayload = await store.getQueueMeta(queueKey);
          if (!customPayload?.question) {
            throw new Error('Missing custom debate metadata');
          }
        }
        await this.gameManager.createGame(user1, user2, gameType, customPayload);
        if (gameType === 'custom') {
          await store.clearQueueMeta(queueKey);
        }
      } catch (err) {
        console.error('[matchmaking] createGame failed:', err.message);
        await Promise.all([
          store.returnToQueue(queueKey, user1, Date.now()),
          store.returnToQueue(queueKey, user2, Date.now())
        ]);
      }
      return;
    }
  }

  static gameTypeFromQueueKey(queueKey) {
    if (typeof queueKey === 'string' && queueKey.startsWith('custom:')) return 'custom';
    return queueKey;
  }

  async _hasLiveSocket(userId) {
    if (await store.isPlayerOnline(userId)) return true;
    try {
      const sockets = await this.io.in(userRoom(userId)).fetchSockets();
      return sockets.length > 0;
    } catch (_) {
      return false;
    }
  }
}

module.exports = Matchmaking;
