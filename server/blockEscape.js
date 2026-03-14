const Game = require('./game');

const ROWS = 5;
const COLS = 5;
const EMPTY = 0;
const WALL = 1;
const EXIT = 2;

// One exit; wall in middle; block starts bottom center. You take turns moving the same block.
function buildGrid() {
  const grid = Array(ROWS).fill(null).map(() => Array(COLS).fill(EMPTY));
  grid[0][2] = EXIT;
  grid[2][2] = WALL;
  return grid;
}

function copyGrid(grid) {
  return grid.map(row => [...row]);
}

class BlockEscape extends Game {
  constructor() {
    super();
    this.grid = null;
    this.block = null;
    this.currentPlayer = null;
    this.winner = null;
    this.playerSymbols = new Map();
  }

  createGame(players) {
    if (players.length !== 2) throw new Error('BlockEscape requires exactly 2 players');
    this.players = players;
    this.grid = buildGrid();
    this.block = [ROWS - 1, Math.floor(COLS / 2)];
    this.currentPlayer = players[0].id;
    this.winner = null;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.createdAt = Date.now();
    return {
      success: true,
      player1: { id: players[0].id, symbol: 'P1' },
      player2: { id: players[1].id, symbol: 'P2' }
    };
  }

  makeMove(playerId, move) {
    if (!this.playerSymbols.has(playerId)) {
      return { success: false, error: 'Not in this game' };
    }
    if (this.isFinished()) {
      return { success: false, error: 'Game is over' };
    }
    if (this.currentPlayer !== playerId) {
      return { success: false, error: 'Not your turn' };
    }

    const row = move.row != null ? Number(move.row) : NaN;
    const col = move.col != null ? Number(move.col) : NaN;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= ROWS || col < 0 || col >= COLS) {
      return { success: false, error: 'Invalid cell' };
    }

    const [br, bc] = this.block;
    const dr = Math.abs(row - br);
    const dc = Math.abs(col - bc);
    if (dr + dc !== 1) {
      return { success: false, error: 'Move the block one step up, down, left, or right' };
    }

    const cell = this.grid[row][col];
    if (cell === WALL) {
      return { success: false, error: 'Cannot move block into wall' };
    }

    this.block[0] = row;
    this.block[1] = col;
    this.currentPlayer = this.players[0].id === playerId ? this.players[1].id : this.players[0].id;

    if (cell === EXIT) {
      this.winner = 'both';
    }

    return { success: true };
  }

  getState() {
    const gridCopy = copyGrid(this.grid);
    return {
      grid: gridCopy,
      block: [this.block[0], this.block[1]],
      currentPlayer: this.currentPlayer ? this.playerSymbols.get(this.currentPlayer) : null,
      winner: this.winner,
      rows: ROWS,
      cols: COLS,
      board: gridCopy,
      isDraw: false
    };
  }

  isFinished() {
    return this.winner === 'both';
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.grid = null;
    this.block = null;
    this.currentPlayer = null;
    this.winner = null;
  }
}

module.exports = BlockEscape;
