const TicTacToe = require('./ticTacToe');
const Connect4 = require('./connect4');

class GameManager {
  constructor(io) {
    this.io = io;
    this.games = new Map(); // gameId -> game
    this.playerToGame = new Map(); // playerId -> gameId
    this.gameFactories = new Map(); // gameType -> GameClass
    this.registerGameType('ticTacToe', TicTacToe);
    this.registerGameType('connect4', Connect4);
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
   * @param {string} gameType - Type of game to create (e.g., 'ticTacToe')
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

    // Get initial state for game-specific properties
    const initialState = game.getState();
    
    // Notify both players with Firebase user IDs
    const gameFoundData = {
      gameId: gameId,
      symbol: initResult.player1.symbol,
      opponentUid: player2.id,  // Firebase user ID
      opponent: player2.id,      // Keep for backward compatibility
      gameType: gameType
    };
    
    // Add game-specific properties if they exist
    if (initialState.rows) gameFoundData.rows = initialState.rows;
    if (initialState.cols) gameFoundData.cols = initialState.cols;
    
    player1.socket.emit('gameFound', gameFoundData);

    const gameFoundData2 = {
      gameId: gameId,
      symbol: initResult.player2.symbol,
      opponentUid: player1.id,  // Firebase user ID
      opponent: player1.id,      // Keep for backward compatibility
      gameType: gameType
    };
    
    if (initialState.rows) gameFoundData2.rows = initialState.rows;
    if (initialState.cols) gameFoundData2.cols = initialState.cols;
    
    player2.socket.emit('gameFound', gameFoundData2);

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
    if (!gameData) {
      return;
    }

    const state = gameData.game.getState();
    const gameState = {
      board: state.board,
      currentPlayer: state.currentPlayer,
      winner: state.winner,
      isDraw: state.isDraw,
      player1Symbol: gameData.player1.symbol,
      player2Symbol: gameData.player2.symbol,
      // Include game-specific properties
      rows: state.rows,
      cols: state.cols,
      gameType: gameData.game.gameType
    };

    // Send to both players
    gameData.player1.socket.emit('gameState', gameState);
    gameData.player2.socket.emit('gameState', gameState);

    // If game is over, clean up after a delay
    if (gameData.game.isFinished()) {
      setTimeout(() => {
        this.endGame(gameId);
      }, 5000);
    }
  }

  endGame(gameId) {
    const gameData = this.games.get(gameId);
    if (gameData) {
      // Use the standard cleanup interface
      gameData.game.cleanup();
      
      this.playerToGame.delete(gameData.player1.id);
      this.playerToGame.delete(gameData.player2.id);
      this.games.delete(gameId);
      console.log(`Game ended: ${gameId}`);
    }
  }

  handleDisconnect(playerId) {
    const gameId = this.playerToGame.get(playerId);
    if (gameId) {
      const gameData = this.games.get(gameId);
      if (gameData) {
        // Notify the other player
        const otherPlayer = gameData.player1.id === playerId 
          ? gameData.player2 
          : gameData.player1;
        
        otherPlayer.socket.emit('opponentDisconnected');
        this.endGame(gameId);
      }
    }
  }

  isPlayerInGame(playerId) {
    return this.playerToGame.has(playerId);
  }
}

module.exports = GameManager;
