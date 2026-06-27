// debateLobby.js — pair players, pick a question, randomly assign sides, start.

const store = require('./gameStore');
const { getDb, getAdmin } = require('./firestoreClient');
const { pickNextQuestionForPair } = require('./questionPicker');
const { recordQuestionShown } = require('./questionHistory');

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

  /**
   * Match two players, pick a question, assign random sides, and start the debate.
   */
  async createLobby(player1Id, player2Id, gameType) {
    const question = await pickNextQuestionForPair([player1Id, player2Id], gameType);
    const selections = this._randomSelections(player1Id, player2Id);

    recordQuestionShown(player1Id, question.questionId).catch(() => {});
    recordQuestionShown(player2Id, question.questionId).catch(() => {});

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
      positions: selections
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
      await this._handleSamePosition(lobbyId, lobbyData, player1Id, player2Id);
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
      positions: selections
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
        matchPayload
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

  async _handleSamePosition(lobbyId, lobbyData, player1Id, player2Id) {
    const db = getDb();
    const ref = db.collection(COLLECTION).doc(lobbyId);
    const gameType = lobbyData.categoryId;

    await ref.update({ status: 'samePosition' });

    await Promise.all([
      store.clearPlayerLobby(player1Id),
      store.clearPlayerLobby(player2Id),
      store.clearLobbySelections(lobbyId),
      store.addAvoidPair(player1Id, player2Id)
    ]);

    const message = 'You both chose the same position. Finding another opponent…';
    for (const uid of [player1Id, player2Id]) {
      this.io.to(userRoom(uid)).emit('lobbyResolved', {
        lobbyId,
        result: 'samePosition',
        message
      });
    }

    await this.matchmaking.requeuePlayer(player1Id, gameType);
    await this.matchmaking.requeuePlayer(player2Id, gameType);

    console.log(`[lobby] same position lobbyId=${lobbyId} — re-queued both`);
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

    if (p1Submitted && !p2Submitted) {
      this.io.to(userRoom(player1Id)).emit('lobbyResolved', {
        lobbyId,
        result: 'timedOut',
        message: 'Your opponent did not choose in time. Finding another opponent…'
      });
      await this.matchmaking.requeuePlayer(player1Id, gameType);
      await store.incrementLobbyAbandon(player2Id);
    } else if (p2Submitted && !p1Submitted) {
      this.io.to(userRoom(player2Id)).emit('lobbyResolved', {
        lobbyId,
        result: 'timedOut',
        message: 'Your opponent did not choose in time. Finding another opponent…'
      });
      await this.matchmaking.requeuePlayer(player2Id, gameType);
      await store.incrementLobbyAbandon(player1Id);
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
    await ref.update({ status: 'cancelled' });
    await store.clearPlayerLobby(userId);
    if (otherId) await store.clearPlayerLobby(otherId);
    await store.clearLobbySelections(lobbyId);
    await store.incrementLobbyAbandon(userId);

    if (otherId) {
      const selections = await store.getLobbySelections(lobbyId);
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
