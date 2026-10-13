// debateLobby.js — pair players, pick a question, assign sides, start.
//
// Two paths:
//   • Default: sides are assigned at random and the debate starts at once.
//   • Side-select (gated, see experiments.js): both players privately pick
//     Support/Oppose on the same question. Opposite picks → human debate.
//     Same pick → each player gets an AI debate on the side they chose, with
//     the same question. The opponent is only withheld until sides are
//     chosen; the debate itself shows a normal opponent card — the human's
//     real profile, or (AI fallback) a random human-looking persona — so the
//     two outcomes look alike.

const store = require('./gameStore');
const { getDb, getAdmin } = require('./firestoreClient');
const { pickNextQuestionForPair } = require('./questionPicker');
const { recordQuestionShown } = require('./questionHistory');
const { sideSelectEnabledFor } = require('./experiments');

const COLLECTION = 'debateLobbies';
const SELECTION_MS = Number(process.env.LOBBY_SELECTION_MS) || 20 * 1000;
const MAX_ABANDON_BEFORE_BLOCK = 3;

function userRoom(userId) {
  return `user:${userId}`;
}

class DebateLobbyManager {
  constructor(io, gameManager, matchmaking) {
    this.io = io;
    this.gameManager = gameManager;
    this.matchmaking = matchmaking;
    // lobbyId -> timeout handle (local to instance; Firestore deadline is authoritative)
    this.selectionTimers = new Map();
  }

  async isPlayerBusy(userId) {
    if (await this.gameManager.isPlayerInGame(userId)) return true;
    if (await store.isPlayerInLobby(userId)) return true;
    return false;
  }

  _randomSelections(player1Id, player2Id) {
    if (Math.random() < 0.5) {
      return { [player1Id]: 'support', [player2Id]: 'oppose' };
    }
    return { [player1Id]: 'oppose', [player2Id]: 'support' };
  }

  async _bothSideSelectEligible(player1Id, player2Id) {
    try {
      const [caps1, caps2] = await Promise.all([
        store.getClientCaps(player1Id),
        store.getClientCaps(player2Id)
      ]);
      const [ok1, ok2] = await Promise.all([
        sideSelectEnabledFor(player1Id, caps1),
        sideSelectEnabledFor(player2Id, caps2)
      ]);
      return ok1 && ok2;
    } catch (err) {
      console.warn('[lobby] side-select eligibility check failed:', err.message);
      return false;
    }
  }

  /**
   * Match two players and pick a question. If both are in the side-select
   * experiment, open a private selection lobby; otherwise assign random sides
   * and start the debate immediately.
   */
  async createLobby(player1Id, player2Id, gameType) {
    const question = await pickNextQuestionForPair([player1Id, player2Id], gameType);

    recordQuestionShown(player1Id, question.questionId).catch(() => {});
    recordQuestionShown(player2Id, question.questionId).catch(() => {});

    if (await this._bothSideSelectEligible(player1Id, player2Id)) {
      return this._createSelectionLobby(player1Id, player2Id, gameType, question);
    }

    const selections = this._randomSelections(player1Id, player2Id);

    let supportUserId = null;
    let opposeUserId = null;
    for (const [uid, pos] of Object.entries(selections)) {
      if (pos === 'support') supportUserId = uid;
      if (pos === 'oppose') opposeUserId = uid;
    }
    if (!supportUserId || !opposeUserId) {
      throw new Error('Failed to assign random sides');
    }

    const matchPayload = {
      question: question.questionText,
      questionId: question.questionId,
      topicTitle: question.topicTitle,
      categoryId: gameType,
      positions: selections,
      ammo: question.ammo || null,
    };

    const gameId = await this.gameManager.createGame(
      supportUserId,
      opposeUserId,
      gameType,
      null,
      matchPayload
    );

    console.log(
      `[lobby] matched gameId=${gameId} p1=${player1Id} p2=${player2Id} questionId=${question.questionId} sides=${JSON.stringify(selections)}`
    );
    return gameId;
  }

  /**
   * Side-select path: persist a lobby both players can see, push the shared
   * question, and wait for private Support/Oppose picks (or the deadline).
   */
  async _createSelectionLobby(player1Id, player2Id, gameType, question) {
    const db = getDb();
    if (!db) throw new Error('Firestore unavailable');

    const lobbyId = `lobby_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const selectionDeadline = Date.now() + SELECTION_MS;
    const admin = getAdmin();

    const lobbyDoc = {
      lobbyId,
      playerIds: [player1Id, player2Id],
      questionId: question.questionId || null,
      questionText: question.questionText,
      categoryId: gameType,
      topicTitle: question.topicTitle || null,
      debateAmmo: question.ammo || null,
      selectionCount: 0,
      status: 'waitingForSelections',
      sideSelect: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      selectionDeadline,
      debateId: null
    };
    await db.collection(COLLECTION).doc(lobbyId).set(lobbyDoc);

    await Promise.all([
      store.setPlayerLobby(player1Id, lobbyId),
      store.setPlayerLobby(player2Id, lobbyId),
      store.clearLobbySelections(lobbyId)
    ]);

    // No opponent identity in this payload on purpose.
    const payload = {
      lobbyId,
      questionId: question.questionId || null,
      questionText: question.questionText,
      categoryId: gameType,
      topicTitle: question.topicTitle || null,
      selectionDeadline,
      status: 'waitingForSelections'
    };
    this.io.to(userRoom(player1Id)).emit('lobbyCreated', payload);
    this.io.to(userRoom(player2Id)).emit('lobbyCreated', payload);

    this._scheduleSelectionTimeout(lobbyId, player1Id, player2Id, gameType, selectionDeadline);

    console.log(
      `[lobby] side-select lobby created lobbyId=${lobbyId} p1=${player1Id} p2=${player2Id} questionId=${question.questionId}`
    );
    return lobbyId;
  }

  _scheduleSelectionTimeout(lobbyId, player1Id, player2Id, gameType, selectionDeadline) {
    const existing = this.selectionTimers.get(lobbyId);
    if (existing) clearTimeout(existing);

    const delay = Math.max(0, selectionDeadline - Date.now()) + 50;
    const handle = setTimeout(() => {
      this.selectionTimers.delete(lobbyId);
      this._handleSelectionTimeout(lobbyId, player1Id, player2Id, gameType).catch((err) => {
        console.error('[lobby] timeout handler failed:', err.message);
      });
    }, delay);
    this.selectionTimers.set(lobbyId, handle);
  }

  _clearSelectionTimer(lobbyId) {
    const t = this.selectionTimers.get(lobbyId);
    if (t) {
      clearTimeout(t);
      this.selectionTimers.delete(lobbyId);
    }
  }

  /**
   * Player submits Support or Oppose privately.
   */
  async submitSelection(userId, lobbyId, position) {
    const side = position === 'oppose' ? 'oppose' : 'support';
    const db = getDb();
    if (!db) return { ok: false, error: 'Firestore unavailable' };

    const ref = db.collection(COLLECTION).doc(lobbyId);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, error: 'Lobby not found' };

    const data = snap.data();
    if (!data.playerIds || !data.playerIds.includes(userId)) {
      return { ok: false, error: 'Not a lobby member' };
    }
    if (data.status !== 'waitingForSelections') {
      return { ok: false, error: 'Lobby no longer accepting selections' };
    }
    if (Date.now() > (data.selectionDeadline || 0)) {
      return { ok: false, error: 'Selection window closed' };
    }

    const stored = await store.setLobbySelection(lobbyId, userId, side);
    if (!stored) {
      return { ok: true, alreadySubmitted: true, position: side };
    }

    const admin = getAdmin();
    await ref.update({ selectionCount: admin.firestore.FieldValue.increment(1) });

    this.io.to(userRoom(userId)).emit('lobbySelectionAck', {
      lobbyId,
      position: side,
      submitted: true
    });

    const selections = await store.getLobbySelections(lobbyId);
    const playerIds = data.playerIds;
    if (playerIds.every((pid) => selections[pid])) {
      await this._resolveSelections(lobbyId, data, selections);
    }

    return { ok: true, position: side };
  }

  async _resolveSelections(lobbyId, lobbyData, selections) {
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(lobbyId);
    const [player1Id, player2Id] = lobbyData.playerIds;
    const pos1 = selections[player1Id];
    const pos2 = selections[player2Id];

    if (!pos1 || !pos2) return;

    this._clearSelectionTimer(lobbyId);

    if (pos1 === pos2) {
      await this._handleSamePosition(lobbyId, lobbyData, player1Id, player2Id, selections);
      return;
    }

    await this._startDebate(lobbyId, lobbyData, player1Id, player2Id, selections);
  }

  async _startDebate(lobbyId, lobbyData, player1Id, player2Id, selections) {
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(lobbyId);
    const gameType = lobbyData.categoryId;

    let supportUserId = null;
    let opposeUserId = null;
    for (const [uid, pos] of Object.entries(selections)) {
      if (pos === 'support') supportUserId = uid;
      if (pos === 'oppose') opposeUserId = uid;
    }

    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const cur = snap.data();
      if (cur.status !== 'waitingForSelections') return false;
      tx.update(ref, { status: 'startingDebate' });
      return true;
    });

    if (!claimed) {
      throw new Error('Lobby claim failed');
    }

    const matchPayload = {
      question: lobbyData.questionText,
      questionId: lobbyData.questionId,
      topicTitle: lobbyData.topicTitle,
      categoryId: gameType,
      positions: selections,
      ammo: lobbyData.debateAmmo || null,
    };

    await Promise.all([
      store.clearPlayerLobby(player1Id),
      store.clearPlayerLobby(player2Id),
      store.clearLobbySelections(lobbyId)
    ]);

    let gameId;
    try {
      gameId = await this.gameManager.createGame(
        supportUserId,
        opposeUserId,
        gameType,
        null,
        matchPayload,
        // Opponent identity was withheld during side selection only; the
        // debate shows the real profile like any other human match.
        { hiddenOpponent: false, sideSelect: true }
      );
    } catch (err) {
      console.error('[lobby] createGame failed:', err.message);
      await ref.update({ status: 'cancelled' });
      await this.matchmaking.requeuePlayer(player1Id, gameType);
      await this.matchmaking.requeuePlayer(player2Id, gameType);
      throw err;
    }

    const admin = getAdmin();
    await ref.update({
      status: 'active',
      debateId: gameId,
      supportUserId,
      opposeUserId,
      resolvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    for (const uid of [player1Id, player2Id]) {
      this.io.to(userRoom(uid)).emit('lobbyResolved', {
        lobbyId,
        result: 'debateStarted',
        debateId: gameId,
        myPosition: selections[uid],
        opponentPosition: selections[uid === player1Id ? player2Id : player1Id]
      });
    }

    console.log(`[lobby] debate started lobbyId=${lobbyId} gameId=${gameId}`);
    return gameId;
  }

  /**
   * Both players picked the same side. Each gets an AI debate on the side
   * they chose, on the same question they were shown. From the player's
   * point of view this looks like the human path (lobbyResolved → gameFound
   * with a named opponent — here a random human-looking AI persona with a
   * photo). The AI game pays like a human game.
   */
  async _handleSamePosition(lobbyId, lobbyData, player1Id, player2Id, selections) {
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(lobbyId);
    const gameType = lobbyData.categoryId;

    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const cur = snap.data();
      if (cur.status !== 'waitingForSelections') return false;
      tx.update(ref, { status: 'samePositionAI' });
      return true;
    });
    if (!claimed) return;

    await Promise.all([
      store.clearPlayerLobby(player1Id),
      store.clearPlayerLobby(player2Id),
      store.clearLobbySelections(lobbyId),
      // Don't re-pair these two for a while — they'd likely agree again.
      store.addAvoidPair(player1Id, player2Id)
    ]);

    const preview = {
      question: lobbyData.questionText,
      questionId: lobbyData.questionId || null,
      topicTitle: lobbyData.topicTitle || null,
      ammo: lobbyData.debateAmmo || null,
      categoryId: gameType
    };

    const gameIds = {};
    for (const uid of [player1Id, player2Id]) {
      const side = selections[uid] === 'oppose' ? 'oppose' : 'support';
      try {
        gameIds[uid] = await this.gameManager.createAIGame(uid, gameType, {
          side,
          preview,
          hiddenOpponent: false,
          aiFallback: true
        });
        this.io.to(userRoom(uid)).emit('lobbyResolved', {
          lobbyId,
          result: 'debateStarted',
          debateId: gameIds[uid],
          myPosition: side,
          opponentPosition: side === 'support' ? 'oppose' : 'support'
        });
      } catch (err) {
        console.error(`[lobby] AI fallback failed for ${uid}:`, err.message);
        this.io.to(userRoom(uid)).emit('lobbyResolved', {
          lobbyId,
          result: 'cancelled',
          message: 'Could not start the debate. Returning to matchmaking…'
        });
        await this.matchmaking.requeuePlayer(uid, gameType).catch(() => {});
      }
    }

    await ref.update({
      status: 'samePositionAI',
      aiDebateIds: gameIds,
      resolvedAt: getAdmin().firestore.FieldValue.serverTimestamp()
    });

    console.log(
      `[lobby] same position lobbyId=${lobbyId} side=${selections[player1Id]} → AI debates ${JSON.stringify(gameIds)}`
    );
  }

  async _handleSelectionTimeout(lobbyId, player1Id, player2Id, gameType) {
    const db = getDb();
    if (!db) return;
    const ref = db.collection(COLLECTION).doc(lobbyId);
    const snap = await ref.get();
    if (!snap.exists) return;

    const data = snap.data();
    if (data.status !== 'waitingForSelections') return;
    if (Date.now() < (data.selectionDeadline || 0)) return;

    const selections = await store.getLobbySelections(lobbyId);
    const p1Submitted = Boolean(selections[player1Id]);
    const p2Submitted = Boolean(selections[player2Id]);

    await ref.update({ status: 'timedOut' });

    await Promise.all([
      store.clearPlayerLobby(player1Id),
      store.clearPlayerLobby(player2Id),
      store.clearLobbySelections(lobbyId)
    ]);

    // Exactly one player picked: start them against the AI on the side they
    // chose (same named-persona treatment), so a slow opponent never costs
    // them the debate. The no-show is counted as an abandon.
    const soloFallback = async (chooserId, noShowId) => {
      const side = selections[chooserId] === 'oppose' ? 'oppose' : 'support';
      try {
        const gameId = await this.gameManager.createAIGame(chooserId, gameType, {
          side,
          preview: {
            question: data.questionText,
            questionId: data.questionId || null,
            topicTitle: data.topicTitle || null,
            ammo: data.debateAmmo || null,
            categoryId: gameType
          },
          hiddenOpponent: false,
          aiFallback: true
        });
        this.io.to(userRoom(chooserId)).emit('lobbyResolved', {
          lobbyId,
          result: 'debateStarted',
          debateId: gameId,
          myPosition: side,
          opponentPosition: side === 'support' ? 'oppose' : 'support'
        });
        await ref.update({ status: 'timedOutAI', aiDebateIds: { [chooserId]: gameId } });
      } catch (err) {
        console.error(`[lobby] timeout AI fallback failed for ${chooserId}:`, err.message);
        this.io.to(userRoom(chooserId)).emit('lobbyResolved', {
          lobbyId,
          result: 'timedOut',
          message: 'Your opponent did not choose in time. Finding another opponent…'
        });
        await this.matchmaking.requeuePlayer(chooserId, gameType);
      }
      // Tell the no-show their lobby is over so the client leaves the picker.
      this.io.to(userRoom(noShowId)).emit('lobbyResolved', {
        lobbyId,
        result: 'timedOut',
        message: 'You did not choose a side in time.'
      });
      await store.incrementLobbyAbandon(noShowId);
    };

    if (p1Submitted && !p2Submitted) {
      await soloFallback(player1Id, player2Id);
    } else if (p2Submitted && !p1Submitted) {
      await soloFallback(player2Id, player1Id);
    } else {
      for (const uid of [player1Id, player2Id]) {
        this.io.to(userRoom(uid)).emit('lobbyResolved', {
          lobbyId,
          result: 'timedOut',
          message: 'Selection timed out. Returning to matchmaking…'
        });
        if (!selections[uid]) await store.incrementLobbyAbandon(uid);
      }
    }

    console.log(`[lobby] timed out lobbyId=${lobbyId} p1=${p1Submitted} p2=${p2Submitted}`);
  }

  async leaveLobby(userId) {
    const lobbyId = await store.getPlayerLobby(userId);
    if (!lobbyId) return;

    const db = getDb();
    if (!db) {
      await store.clearPlayerLobby(userId);
      return;
    }

    const ref = db.collection(COLLECTION).doc(lobbyId);
    const snap = await ref.get();
    if (!snap.exists) {
      await store.clearPlayerLobby(userId);
      return;
    }

    const data = snap.data();
    if (data.status !== 'waitingForSelections') {
      await store.clearPlayerLobby(userId);
      return;
    }

    const otherId = (data.playerIds || []).find((id) => id !== userId);
    const gameType = data.categoryId;

    this._clearSelectionTimer(lobbyId);
    const selections = await store.getLobbySelections(lobbyId);
    await ref.update({ status: 'cancelled' });
    await store.clearPlayerLobby(userId);
    if (otherId) await store.clearPlayerLobby(otherId);
    await store.clearLobbySelections(lobbyId);
    await store.incrementLobbyAbandon(userId);

    if (otherId) {
      if (selections[otherId]) {
        this.io.to(userRoom(otherId)).emit('lobbyResolved', {
          lobbyId,
          result: 'opponentLeft',
          message: 'Your opponent left. Finding another opponent…'
        });
        await this.matchmaking.requeuePlayer(otherId, gameType);
      } else {
        this.io.to(userRoom(otherId)).emit('lobbyResolved', {
          lobbyId,
          result: 'cancelled',
          message: 'Your opponent left. Returning to matchmaking…'
        });
        await this.matchmaking.requeuePlayer(otherId, gameType);
      }
    }
  }

  async reattachLobby(userId, socket) {
    const lobbyId = await store.getPlayerLobby(userId);
    if (!lobbyId) return false;

    const db = getDb();
    if (!db) return false;
    const snap = await db.collection(COLLECTION).doc(lobbyId).get();
    if (!snap.exists) {
      await store.clearPlayerLobby(userId);
      return false;
    }

    const data = snap.data();
    if (data.status !== 'waitingForSelections') {
      await store.clearPlayerLobby(userId);
      return false;
    }

    socket.emit('lobbyCreated', {
      lobbyId,
      questionId: data.questionId,
      questionText: data.questionText,
      categoryId: data.categoryId,
      topicTitle: data.topicTitle,
      selectionDeadline: data.selectionDeadline,
      status: data.status
    });

    const selections = await store.getLobbySelections(lobbyId);
    if (selections[userId]) {
      socket.emit('lobbySelectionAck', {
        lobbyId,
        position: selections[userId],
        submitted: true
      });
    }
    return true;
  }
}

module.exports = DebateLobbyManager;
