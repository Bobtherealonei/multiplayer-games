const Game = require('./game');

class Connect4 extends Game {
  constructor() {
    super();
    this.rows = 6;
    this.cols = 7;
    this.board = null;
    this.currentPlayer = 'R'; // R = Red, Y = Yellow
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
      throw new Error('Connect4 requires exactly 2 players');
    }

    this.players = players;
    this.playerSymbols.set(players[0].id, 'R');
    this.playerSymbols.set(players[1].id, 'Y');
    this.currentPlayer = 'R';
    this.board = Array(this.rows).fill(null).map(() => Array(this.cols).fill(null));
    this.winner = null;
    this.isDraw = false;
    this.createdAt = Date.now();

    return {
      success: true,
      player1: { id: players[0].id, symbol: 'R' },
      player2: { id: players[1].id, symbol: 'Y' }
    };
  }

  /**
   * Process a move from a player
   * @param {string} playerId - ID of the player making the move
   * @param {Object} move - Move data with column property (0-6)
   */
  makeMove(playerId, move) {
    // Validate player
    if (!this.playerSymbols.has(playerId)) {
      return { success: false, error: 'Player not in this game' };
    }

    const playerSymbol = this.playerSymbols.get(playerId);
    const { column } = move;

    // Validate column
    if (column === undefined || column < 0 || column >= this.cols) {
      return { success: false, error: 'Invalid column' };
    }

    // Check if column is full
    if (this.board[0][column] !== null) {
      return { success: false, error: 'Column is full' };
    }

    if (this.currentPlayer !== playerSymbol) {
      return { success: false, error: 'Not your turn' };
    }

    if (this.isFinished()) {
      return { success: false, error: 'Game is over' };
    }

    // Find the lowest empty row in the column
    let row = -1;
    for (let r = this.rows - 1; r >= 0; r--) {
      if (this.board[r][column] === null) {
        row = r;
        break;
      }
    }

    if (row === -1) {
      return { success: false, error: 'Column is full' };
    }

    // Make the move
    this.board[row][column] = playerSymbol;
    
    // Check for winner
    this.winner = this.checkWinner(row, column);
    
    // Check for draw (board is full)
    if (!this.winner && this.isBoardFull()) {
      this.isDraw = true;
    }

    // Switch player
    if (!this.isFinished()) {
      this.currentPlayer = this.currentPlayer === 'R' ? 'Y' : 'R';
    }

    return {
      success: true
    };
  }

  /**
   * Check if there's a winner starting from the last move position
   */
  checkWinner(row, col) {
    const symbol = this.board[row][col];
    const directions = [
      [0, 1],   // horizontal
      [1, 0],   // vertical
      [1, 1],   // diagonal /
      [1, -1]   // diagonal \
    ];

    for (const [dx, dy] of directions) {
      let count = 1; // Count the current piece

      // Check in positive direction
      for (let i = 1; i < 4; i++) {
        const newRow = row + dx * i;
        const newCol = col + dy * i;
        if (newRow >= 0 && newRow < this.rows && 
            newCol >= 0 && newCol < this.cols &&
            this.board[newRow][newCol] === symbol) {
          count++;
        } else {
          break;
        }
      }

      // Check in negative direction
      for (let i = 1; i < 4; i++) {
        const newRow = row - dx * i;
        const newCol = col - dy * i;
        if (newRow >= 0 && newRow < this.rows && 
            newCol >= 0 && newCol < this.cols &&
            this.board[newRow][newCol] === symbol) {
          count++;
        } else {
          break;
        }
      }

      if (count >= 4) {
        return symbol;
      }
    }

    return null;
  }

  /**
   * Check if the board is full
   */
  isBoardFull() {
    for (let col = 0; col < this.cols; col++) {
      if (this.board[0][col] === null) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get the current state of the game
   */
  getState() {
    return {
      board: this.board,
      rows: this.rows,
      cols: this.cols,
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

module.exports = Connect4;

