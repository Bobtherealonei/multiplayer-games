const Game = require('./game');

class TicTacToe extends Game {
  constructor() {
    super();
    this.board = Array(9).fill(null);
    this.currentPlayer = 'X';
    this.winner = null;
    this.isDraw = false;
    this.playerSymbols = new Map(); // playerId -> symbol
  }

  /**
   * Initialize the game with players
   * @param {Array} players - Array of two player objects
   */
  createGame(players) {
    if (players.length !== 2) {
      throw new Error('TicTacToe requires exactly 2 players');
    }

    this.players = players;
    this.playerSymbols.set(players[0].id, 'X');
    this.playerSymbols.set(players[1].id, 'O');
    this.currentPlayer = 'X';
    this.board = Array(9).fill(null);
    this.winner = null;
    this.isDraw = false;
    this.createdAt = Date.now();

    return {
      success: true,
      player1: { id: players[0].id, symbol: 'X' },
      player2: { id: players[1].id, symbol: 'O' }
    };
  }

  /**
   * Process a move from a player
   * @param {string} playerId - ID of the player making the move
   * @param {Object} move - Move data with position property
   */
  makeMove(playerId, move) {
    // Validate player
    if (!this.playerSymbols.has(playerId)) {
      return { success: false, error: 'Player not in this game' };
    }

    const playerSymbol = this.playerSymbols.get(playerId);
    const { position } = move;

    // Validate position
    if (position === undefined || position < 0 || position > 8) {
      return { success: false, error: 'Invalid position' };
    }

    // Validate move
    if (this.board[position] !== null) {
      return { success: false, error: 'Position already taken' };
    }

    if (this.currentPlayer !== playerSymbol) {
      return { success: false, error: 'Not your turn' };
    }

    if (this.isFinished()) {
      return { success: false, error: 'Game is over' };
    }

    // Make the move
    this.board[position] = playerSymbol;
    
    // Check for winner
    this.winner = this.checkWinner();
    
    // Check for draw
    if (!this.winner && !this.board.includes(null)) {
      this.isDraw = true;
    }

    // Switch player
    if (!this.isFinished()) {
      this.currentPlayer = this.currentPlayer === 'X' ? 'O' : 'X';
    }

    return {
      success: true
    };
  }

  checkWinner() {
    const winPatterns = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
      [0, 4, 8], [2, 4, 6]             // Diagonals
    ];

    for (const pattern of winPatterns) {
      const [a, b, c] = pattern;
      if (this.board[a] && 
          this.board[a] === this.board[b] && 
          this.board[a] === this.board[c]) {
        return this.board[a];
      }
    }

    return null;
  }

  /**
   * Get the current state of the game
   */
  getState() {
    return {
      board: this.board,
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      isDraw: this.isDraw,
      players: this.players.map(p => ({
        id: p.id,
        symbol: this.playerSymbols.get(p.id)
      }))
    };
  }

  /**
   * Check if the game is finished
   */
  isFinished() {
    return this.winner !== null || this.isDraw;
  }

  /**
   * Clean up resources
   */
  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.board = null;
  }
}

module.exports = TicTacToe;

