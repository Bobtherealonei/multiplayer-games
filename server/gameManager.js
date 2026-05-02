const TopicDebate = require('./topicDebate');

// How long we wait after a socket drops before declaring the player gone for
// good. Socket.IO Swift auto-reconnects with a short backoff, so most transient
// blips (app backgrounding, WiFi→cellular handover, brief packet loss) are
// resolved well within this window. Without this grace period the OTHER player
// gets kicked with "Player has disconnected" any time their opponent's phone
// briefly drops the connection.
const RECONNECT_GRACE_MS = 12000;

class GameManager {
  constructor(io) {
    this.io = io;
    this.games = new Map();
    this.playerToGame = new Map();
    this.gameFactories = new Map();
    // userId -> setTimeout handle for a pending "your opponent disconnected"
    // notification. Cancelled if the player reconnects within the grace window.
    this.pendingDisconnects = new Map();
    // All "game types" are debate topics — the legacy 'religion' key is the
    // Trending in the USA slot.
    this.registerGameType('religion', TopicDebate);
    this.registerGameType('aiFuture', TopicDebate);
    this.registerGameType('currentPolitics', TopicDebate);
    this.registerGameType('collegeCareers', TopicDebate);
    this.registerGameType('sportsDebate', TopicDebate);
  }

  /**
   * Register a game type with its class
   * @param {string} gameType - The game type identifier
   * @param {Class} GameClass - The game class that extends Game
   */
  registerGameType(gameType, GameClass) {
    this.gameFactories.set(gameType, GameClass);
  }

  /**
   * Create a game instance based on gameType
   * @param {Object} player1 - First player
   * @param {Object} player2 - Second player
   * @param {string} gameType - Debate topic key (e.g., 'religion', 'aiFuture')
   */
  createGame(player1, player2, gameType) {
    // Get the game class for this gameType
    const GameClass = this.gameFactories.get(gameType);
    if (!GameClass) {
      throw new Error(`Unknown game type: ${gameType}`);
    }

    const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const game = new GameClass();
    game.gameId = gameId;
    game.gameType = gameType;
    
    // Create game with players using the standard interface
    const players = [
      { id: player1.id, socket: player1.socket },
      { id: player2.id, socket: player2.socket }
    ];
    
    const initResult = game.createGame(players);
    
    // Store game data
    const gameData = {
      id: gameId,
      game: game,
      player1: { id: player1.id, socket: player1.socket, symbol: initResult.player1.symbol },
      player2: { id: player2.id, socket: player2.socket, symbol: initResult.player2.symbol }
    };

    this.games.set(gameId, gameData);
    this.playerToGame.set(player1.id, gameId);
    this.playerToGame.set(player2.id, gameId);

    // Notify both players with Firebase user IDs
    player1.socket.emit('gameFound', {
      gameId: gameId,
      symbol: initResult.player1.symbol,
      opponentUid: player2.id,
      opponent: player2.id,      // legacy field, kept for backward compatibility
      gameType: gameType
    });

    player2.socket.emit('gameFound', {
      gameId: gameId,
      symbol: initResult.player2.symbol,
      opponentUid: player1.id,
      opponent: player1.id,      // legacy field, kept for backward compatibility
      gameType: gameType
    });

    // Send initial game state
    this.sendGameState(gameId);

    console.log(`Game created: ${gameId} between ${player1.id} and ${player2.id}`);
  }

  handleMove(playerId, data) {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) {
      return;
    }

    const gameData = this.games.get(gameId);
    if (!gameData) {
      return;
    }

    const player = gameData.player1.id === playerId ? gameData.player1 : gameData.player2;
    
    // Use the standard interface: makeMove(playerId, move)
    const result = gameData.game.makeMove(playerId, data);

    if (result.success) {
      this.sendGameState(gameId);
    } else {
      player.socket.emit('moveError', { error: result.error });
    }
  }

  // ✅ Chat relay (send only to receiver)
  handleChat(playerId, payload) {
    const gameId = payload?.gameId || this.playerToGame.get(playerId);
    if (!gameId) return;

    const gameData = this.games.get(gameId);
    if (!gameData) return;

    const receiver = gameData.player1.id === playerId ? gameData.player2 : gameData.player1;

    const messagePayload = {
      message: payload?.message,
      sender: payload?.sender,
      symbol: payload?.symbol,
      gameId: gameId,
      playerId: playerId
    };

    receiver.socket.emit('chatMessage', messagePayload);
  }

  sendGameState(gameId) {
    const gameData = this.games.get(gameId);
    if (!gameData) return;

    const gameState = {
      player1Symbol: gameData.player1.symbol,
      player2Symbol: gameData.player2.symbol,
      gameType: gameData.game.gameType,
      ...gameData.game.getState()
    };

    gameData.player1.socket.emit('gameState', gameState);
    gameData.player2.socket.emit('gameState', gameState);
  }

  endGame(gameId) {
    const gameData = this.games.get(gameId);
    if (gameData) {
      // Use the standard cleanup interface
      gameData.game.cleanup();

      // Cancel any pending grace-period timers so they don't fire against a
      // game that no longer exists (avoids both a no-op log line and a leak).
      for (const playerId of [gameData.player1.id, gameData.player2.id]) {
        const t = this.pendingDisconnects.get(playerId);
        if (t) {
          clearTimeout(t);
          this.pendingDisconnects.delete(playerId);
        }
      }

      this.playerToGame.delete(gameData.player1.id);
      this.playerToGame.delete(gameData.player2.id);
      this.games.delete(gameId);
      console.log(`Game ended: ${gameId}`);
    }
  }

  handleLeaveGame(playerId, message = 'Player has disconnected') {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) {
      return;
    }

    const gameData = this.games.get(gameId);
    if (!gameData) {
      return;
    }

    const payload = { message, gameId };
    gameData.player1.socket.emit('playerLeft', payload);
    gameData.player2.socket.emit('playerLeft', payload);
    this.endGame(gameId);
  }

  // Schedule, not execute, the "opponent disconnected" notification. If the
  // player's socket reconnects within RECONNECT_GRACE_MS we cancel this and the
  // other player never even sees a hiccup. If they don't reconnect in time, we
  // fire the notification and end the game.
  handleDisconnect(playerId) {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return;

    // Defensively clear any prior pending timer for this user (e.g. if they
    // dropped, came back, then dropped again — we want the new grace period).
    const existing = this.pendingDisconnects.get(playerId);
    if (existing) clearTimeout(existing);

    const handle = setTimeout(() => {
      this.pendingDisconnects.delete(playerId);

      const gameData = this.games.get(gameId);
      if (!gameData) return; // game already ended (e.g. via leaveGame)

      // If the socket reference for this user has been swapped out via
      // reattachSocket, they reconnected — bail out without kicking anyone.
      const myEntry = gameData.player1.id === playerId ? gameData.player1 : gameData.player2;
      if (myEntry.socket && myEntry.socket.connected) return;

      const otherPlayer = gameData.player1.id === playerId
        ? gameData.player2
        : gameData.player1;

      otherPlayer.socket.emit('opponentDisconnected', { message: 'Player has disconnected', gameId });
      this.endGame(gameId);
    }, RECONNECT_GRACE_MS);

    this.pendingDisconnects.set(playerId, handle);
  }

  // Called from the io connection handler when a NEW socket arrives carrying
  // a userId that already has an active game. Swaps the new socket into the
  // game data so subsequent emits reach the live connection, cancels any
  // pending disconnect timer, and re-syncs the client's state.
  reattachSocket(userId, socket) {
    const gameId = this.playerToGame.get(userId);
    if (!gameId) return false;

    const gameData = this.games.get(gameId);
    if (!gameData) return false;

    if (gameData.player1.id === userId) {
      gameData.player1.socket = socket;
    } else if (gameData.player2.id === userId) {
      gameData.player2.socket = socket;
    } else {
      return false;
    }

    const pending = this.pendingDisconnects.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.pendingDisconnects.delete(userId);
    }

    // Push current game state to the reattached client so it doesn't have a
    // stale view (helps when the iOS view model survived but the socket churned).
    this.sendGameState(gameId);
    return true;
  }

  isPlayerInGame(playerId) {
    return this.playerToGame.has(playerId);
  }
}

module.exports = GameManager;
