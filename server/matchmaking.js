// matchmaking.js — pairs up two players who picked the same debate topic.
//
// Multi-instance design:
//   The "queue" is a Redis sorted set per gameType (member = userId,
//   score = joinedAt). The atomic "pop two oldest" operation is a Lua
//   script over ZPOPMIN — see gameStore.popPair. That guarantees no two
//   instances can ever match the same pair, which is the canonical
//   horizontal-scaling bug we'd otherwise have.
//
// All emits to the player flow through user-room emits (`user:{userId}`)
// instead of the socket reference, so this code doesn't care which
// instance the player is connected to.

const store = require('./gameStore');

function userRoom(userId) { return `user:${userId}`; }

class Matchmaking {
  constructor(gameManager, io) {
    this.gameManager = gameManager;
    this.io = io;
  }

  async addPlayer(socket, gameType, userId, options = {}) {
    if (!gameType) {
      socket.emit('matchmakingStatus', { status: 'error', error: 'gameType is required' });
      return;
    }

    const queueKey = Matchmaking.queueKeyFor(gameType, options);
    const resolvedGameType = Matchmaking.gameTypeFromQueueKey(queueKey);

    // Drop any stale queue entries for this user before re-adding — handles
    // the case where iOS rejoined matchmaking after a soft reconnect or
    // changed gameType mid-search.
    await store.removeFromAllQueues(userId);

    if (await this.gameManager.isPlayerInGame(userId)) {
      socket.emit('matchmakingStatus', { status: 'alreadyInGame' });
      return;
    }

    if (resolvedGameType === 'custom') {
      if (!options.customDebateId || !options.question) {
        socket.emit('matchmakingStatus', {
          status: 'error',
          error: 'customDebateId and question are required for custom debates'
        });
        return;
      }
      await store.setQueueMeta(queueKey, {
        customDebateId: options.customDebateId,
        question: options.question,
        topicTitle: options.topicTitle || 'Custom'
      });
    }

    await store.enqueuePlayer(queueKey, userId);
    socket.emit('matchmakingStatus', { status: 'searching', gameType: resolvedGameType });

    await this.tryMatchmaking(queueKey, resolvedGameType);
  }

  static queueKeyFor(gameType, options = {}) {
    if (gameType === 'custom' && options.customDebateId) {
      return `custom:${options.customDebateId}`;
    }
    return gameType;
  }

  static gameTypeFromQueueKey(queueKey) {
    if (typeof queueKey === 'string' && queueKey.startsWith('custom:')) return 'custom';
    return queueKey;
  }

  async removePlayer(userId) {
    await store.removeFromAllQueues(userId);
  }

  async tryMatchmaking(queueKey, gameType = Matchmaking.gameTypeFromQueueKey(queueKey)) {
    // popPair is atomic across instances. Loop in case the first pair we
    // pop has a dead user (one who closed the app) — the second user
    // returns to the queue and we try again.
    for (let attempt = 0; attempt < 5; attempt++) {
      const pair = await store.popPair(queueKey);
      if (!pair) return; // queue has fewer than 2 — done

      // popPair telegraphs a too-old entry by returning { stale: userId }.
      // Drop it and keep going.
      if (pair.stale) {
        if (pair.returned) {
          // The other user from the pair was fine; put them back so the
          // next eligible newcomer can match against them.
          await store.returnToQueue(queueKey, pair.returned, Date.now());
        }
        continue;
      }

      const { user1, user2 } = pair;

      // Verify both have at least one live socket in the cluster. If a
      // player closed their app between enqueue and pop, returnToQueue
      // the survivor and try again.
      const live = await Promise.all([
        this._hasLiveSocket(user1),
        this._hasLiveSocket(user2)
      ]);
      if (!live[0] && !live[1]) {
        continue; // both dead, drop both
      }
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
        // Best effort: requeue both. Worst case the requeue itself fails
        // and the iOS client retries findMatch on its own, which will
        // re-enqueue them.
        await Promise.all([
          store.returnToQueue(queueKey, user1, Date.now()),
          store.returnToQueue(queueKey, user2, Date.now())
        ]);
      }
      return;
    }
  }

  async _hasLiveSocket(userId) {
    try {
      const sockets = await this.io.in(userRoom(userId)).fetchSockets();
      return sockets.length > 0;
    } catch (_) {
      return false;
    }
  }
}

module.exports = Matchmaking;
