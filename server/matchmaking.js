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

// How long a player waits for an EXACT opposite-side match on their specific
// question before we relax to "any opposite side on the same topic".
const FALLBACK_MS = 9000;

function oppositePosition(position) {
  return position === 'oppose' ? 'support' : 'oppose';
}

class Matchmaking {
  constructor(gameManager, io) {
    this.gameManager = gameManager;
    this.io = io;
    // userId -> setTimeout handle for the exact->topic fallback. LOCAL ONLY
    // (same rationale as gameManager.pendingDisconnects): when the timer
    // fires we re-check shared Redis state, so a dead instance just means the
    // timer never fires and the queue entry eventually goes stale.
    this.fallbackTimers = new Map();
  }

  async addPlayer(socket, gameType, userId, options = {}) {
    if (!gameType) {
      socket.emit('matchmakingStatus', { status: 'error', error: 'gameType is required' });
      return;
    }

    // Drop any stale queue entries / context for this user before re-adding —
    // handles iOS rejoining after a soft reconnect or changing topic mid-search.
    await store.removeFromAllQueues(userId);
    await store.clearMatchContext(userId);
    this._clearFallbackTimer(userId);

    if (await this.gameManager.isPlayerInGame(userId)) {
      socket.emit('matchmakingStatus', { status: 'alreadyInGame' });
      return;
    }

    // ── Custom debates: unchanged same-question, same-queue pairing ────────
    if (gameType === 'custom') {
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

    // ── Position-based topic debates ───────────────────────────────────────
    const position = options.position === 'oppose' ? 'oppose' : 'support';
    const questionId = String(options.questionId || 'none');
    const question = options.question || '';
    const topicTitle = options.topicTitle || '';

    await store.setMatchContext(userId, { gameType, questionId, question, position, topicTitle });

    const myQueue = Matchmaking.exactQueueKey(gameType, questionId, position);
    await store.enqueuePlayer(myQueue, userId);
    socket.emit('matchmakingStatus', { status: 'searching', gameType });

    await this.tryExactMatch(gameType, questionId);

    // If still searching, fall back to topic-wide opposite-side matching.
    this._scheduleFallback(gameType, userId, position);
  }

  static exactQueueKey(gameType, questionId, position) {
    return `${gameType}::q::${questionId}::${position}`;
  }

  static anyQueueKey(gameType, position) {
    return `${gameType}::any::${position}`;
  }

  async removePlayer(userId) {
    await store.removeFromAllQueues(userId);
    await store.clearMatchContext(userId);
    this._clearFallbackTimer(userId);
  }

  _clearFallbackTimer(userId) {
    const t = this.fallbackTimers.get(userId);
    if (t) {
      clearTimeout(t);
      this.fallbackTimers.delete(userId);
    }
  }

  _scheduleFallback(gameType, userId, position) {
    this._clearFallbackTimer(userId);
    const handle = setTimeout(async () => {
      this.fallbackTimers.delete(userId);
      try {
        // Still searching? (context cleared on match / leave)
        const ctx = await store.getMatchContext(userId);
        if (!ctx) return;
        if (await this.gameManager.isPlayerInGame(userId)) return;
        if (!(await this._hasLiveSocket(userId))) {
          await this.removePlayer(userId);
          return;
        }
        // Move from the exact queue into the topic-wide "any" pool, then try
        // to pair against any opposite-side waiter on the same topic.
        await store.removeFromAllQueues(userId);
        await store.enqueuePlayer(Matchmaking.anyQueueKey(gameType, position), userId);
        await this.tryAnyMatch(gameType);
      } catch (err) {
        console.error('[matchmaking] fallback failed:', err.message);
      }
    }, FALLBACK_MS);
    this.fallbackTimers.set(userId, handle);
  }

  async tryExactMatch(gameType, questionId) {
    const supportKey = Matchmaking.exactQueueKey(gameType, questionId, 'support');
    const opposeKey = Matchmaking.exactQueueKey(gameType, questionId, 'oppose');
    await this._popAndFinalize(gameType, supportKey, opposeKey);
  }

  async tryAnyMatch(gameType) {
    const supportKey = Matchmaking.anyQueueKey(gameType, 'support');
    const opposeKey = Matchmaking.anyQueueKey(gameType, 'oppose');
    await this._popAndFinalize(gameType, supportKey, opposeKey);
  }

  async _popAndFinalize(gameType, supportKey, opposeKey) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pair = await store.popOpposingPair(supportKey, opposeKey);
      if (!pair) return; // one side empty — nothing to do

      if (pair.stale) {
        // Re-seat whichever side survived so a fresh opponent can match it.
        if (pair.supportUser) await store.returnToQueue(supportKey, pair.supportUser, Date.now());
        if (pair.opposeUser) await store.returnToQueue(opposeKey, pair.opposeUser, Date.now());
        continue;
      }

      const { supportUser, opposeUser } = pair;

      const live = await Promise.all([
        this._hasLiveSocket(supportUser),
        this._hasLiveSocket(opposeUser)
      ]);
      if (!live[0] && !live[1]) continue;
      if (!live[0]) { await store.returnToQueue(opposeKey, opposeUser, Date.now()); continue; }
      if (!live[1]) { await store.returnToQueue(supportKey, supportUser, Date.now()); continue; }

      const ok = await this._finalizeMatch(gameType, supportUser, opposeUser);
      if (!ok) {
        // createGame failed — re-seat both and let the clients retry.
        await store.returnToQueue(supportKey, supportUser, Date.now());
        await store.returnToQueue(opposeKey, opposeUser, Date.now());
      }
      return;
    }
  }

  async _finalizeMatch(gameType, supportUser, opposeUser) {
    const [supportCtx, opposeCtx] = await Promise.all([
      store.getMatchContext(supportUser),
      store.getMatchContext(opposeUser)
    ]);

    // Use the Support player's question as the debate question (deterministic);
    // fall back to the Oppose player's if Support's is missing.
    const question = (supportCtx && supportCtx.question) || (opposeCtx && opposeCtx.question) || '';
    const questionId = (supportCtx && supportCtx.questionId) || (opposeCtx && opposeCtx.questionId) || 'none';
    const topicTitle = (supportCtx && supportCtx.topicTitle) || (opposeCtx && opposeCtx.topicTitle) || '';

    const matchPayload = {
      question,
      questionId: questionId === 'none' ? null : questionId,
      topicTitle,
      positions: { [supportUser]: 'support', [opposeUser]: 'oppose' }
    };

    // Clear search state for both before creating the game.
    this._clearFallbackTimer(supportUser);
    this._clearFallbackTimer(opposeUser);
    await Promise.all([
      store.clearMatchContext(supportUser),
      store.clearMatchContext(opposeUser),
      store.removeFromAllQueues(supportUser),
      store.removeFromAllQueues(opposeUser)
    ]);

    try {
      await this.gameManager.createGame(supportUser, opposeUser, gameType, null, matchPayload);
      return true;
    } catch (err) {
      console.error('[matchmaking] createGame failed:', err.message);
      return false;
    }
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
