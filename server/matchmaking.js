// matchmaking.js — pairs players who chose opposite positions on the SAME
// active questionId for a category.
//
// All users entering matchmaking during a rotation window must use the
// server's current active question (activeDebateQuestions/{gameType}). Exact
// questionId + opposite position only — no topic-wide fallback.

const store = require('./gameStore');
const { getActiveQuestion, normalizeDoc, isStillActive } = require('./activeDebateQuestion');

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

    await store.removeFromAllQueues(userId);
    await store.clearMatchContext(userId);

    if (await this.gameManager.isPlayerInGame(userId)) {
      socket.emit('matchmakingStatus', { status: 'alreadyInGame' });
      return;
    }

    // ── Custom debates: unchanged ──────────────────────────────────────────
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

    // ── Position-based topic debates (shared active question) ──────────────
    const position = options.position === 'oppose' ? 'oppose' : 'support';

    let active;
    try {
      active = normalizeDoc(await getActiveQuestion(gameType));
    } catch (err) {
      console.error('[matchmaking] getActiveQuestion failed:', err.message);
      socket.emit('matchmakingStatus', { status: 'error', error: 'Could not load active question' });
      return;
    }

    const activeQuestionId = String(active.questionId || 'none');
    const clientQuestionId = String(options.questionId || '');
    const clientExpiresAt = Number(options.questionExpiresAt || 0);

    let questionId = activeQuestionId;
    let question = active.questionText;
    let topicTitle = active.topicTitle || '';

    if (clientQuestionId) {
      if (clientQuestionId === activeQuestionId) {
        // Current active question — use authoritative server text.
      } else if (clientExpiresAt > Date.now()) {
        // Previous rotation window: user loaded this question before it expired.
        questionId = clientQuestionId;
        question = String(options.question || active.questionText);
        topicTitle = String(options.topicTitle || active.topicTitle || '');
        console.log(
          `[matchmaking] user=${userId} queued on previous questionId=${questionId} expires=${new Date(clientExpiresAt).toISOString()}`
        );
      } else {
        console.log(
          `[matchmaking] rejected stale question user=${userId} clientQuestionId=${clientQuestionId} activeQuestionId=${activeQuestionId}`
        );
        socket.emit('matchmakingStatus', {
          status: 'questionStale',
          activeQuestion: {
            questionId: active.questionId,
            questionText: active.questionText,
            question: active.questionText,
            categoryId: gameType,
            topicTitle: active.topicTitle,
            expiresAt: active.expiresAt
          }
        });
        return;
      }
    }

    console.log(
      `[matchmaking] enqueue user=${userId} activeQuestionId=${questionId} position=${position} category=${gameType}`
    );

    await store.setMatchContext(userId, {
      gameType,
      questionId,
      question,
      position,
      topicTitle,
      questionExpiresAt: String(active.expiresAt || options.questionExpiresAt || '')
    });

    const myQueue = Matchmaking.exactQueueKey(gameType, questionId, position);
    await store.enqueuePlayer(myQueue, userId);
    socket.emit('matchmakingStatus', { status: 'searching', gameType, questionId });

    await this.tryExactMatch(gameType, questionId);
  }

  static exactQueueKey(gameType, questionId, position) {
    return `${gameType}::q::${questionId}::${position}`;
  }

  async removePlayer(userId) {
    await store.removeFromAllQueues(userId);
    await store.clearMatchContext(userId);
  }

  async tryExactMatch(gameType, questionId) {
    const supportKey = Matchmaking.exactQueueKey(gameType, questionId, 'support');
    const opposeKey = Matchmaking.exactQueueKey(gameType, questionId, 'oppose');
    await this._popAndFinalize(gameType, questionId, supportKey, opposeKey);
  }

  async _popAndFinalize(gameType, questionId, supportKey, opposeKey) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pair = await store.popOpposingPair(supportKey, opposeKey);
      if (!pair) return;

      if (pair.stale) {
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

      console.log(
        `[matchmaking] matched questionId=${questionId} support=${supportUser} oppose=${opposeUser} category=${gameType}`
      );

      const ok = await this._finalizeMatch(gameType, questionId, supportUser, opposeUser);
      if (!ok) {
        await store.returnToQueue(supportKey, supportUser, Date.now());
        await store.returnToQueue(opposeKey, opposeUser, Date.now());
      }
      return;
    }
  }

  async _finalizeMatch(gameType, questionId, supportUser, opposeUser) {
    const [supportCtx, opposeCtx] = await Promise.all([
      store.getMatchContext(supportUser),
      store.getMatchContext(opposeUser)
    ]);

    const question = (supportCtx && supportCtx.question) || (opposeCtx && opposeCtx.question) || '';
    const resolvedQuestionId = questionId || (supportCtx && supportCtx.questionId) || 'none';
    const topicTitle = (supportCtx && supportCtx.topicTitle) || (opposeCtx && opposeCtx.topicTitle) || '';

    const matchPayload = {
      question,
      questionId: resolvedQuestionId === 'none' ? null : resolvedQuestionId,
      topicTitle,
      categoryId: gameType,
      positions: { [supportUser]: 'support', [opposeUser]: 'oppose' }
    };

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
    try {
      const sockets = await this.io.in(userRoom(userId)).fetchSockets();
      return sockets.length > 0;
    } catch (_) {
      return false;
    }
  }
}

module.exports = Matchmaking;
