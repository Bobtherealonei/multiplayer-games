const Game = require('./game');

const ROWS = 5;
const COLS = 5;
const MINES_COUNT = 3;
const HIDDEN = 'H';
const SAFE = 'S';
const MINE = 'M';

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function placeMines(count) {
  const indices = new Set();
  const total = ROWS * COLS;
  while (indices.size < count) {
    indices.add(randomInt(total));
  }
  return Array.from(indices);
}

class Mines extends Game {
  constructor() {
    super();
    this.board = null;       // 2D ROWS x COLS: H / S / M
    this.mineIndices = null; // Set of indices that have mines
    this.currentPlayer = 'P1';
    this.winner = null;      // Who did NOT hit the mine (the survivor)
    this.isDraw = false;
    this.playerSymbols = new Map();
  }

  createGame(players) {
    if (players.length !== 2) {
      throw new Error('Mines requires exactly 2 players');
    }

    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.currentPlayer = 'P1';
    this.winner = null;
    this.isDraw = false;
    this.mineIndices = new Set(placeMines(MINES_COUNT));

    this.board = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        row.push(HIDDEN);
      }
      this.board.push(row);
    }
    this.createdAt = Date.now();

    return {
      success: true,
      player1: { id: players[0].id, symbol: 'P1' },
      player2: { id: players[1].id, symbol: 'P2' }
    };
  }

  makeMove(playerId, move) {
    if (!this.playerSymbols.has(playerId)) {
      return { success: false, error: 'Player not in this game' };
    }

    const playerSymbol = this.playerSymbols.get(playerId);
    const index = move?.index;

    if (index === undefined || typeof index !== 'number' || index < 0 || index >= ROWS * COLS) {
      return { success: false, error: 'Invalid cell' };
    }

    if (this.currentPlayer !== playerSymbol) {
      return { success: false, error: 'Not your turn' };
    }

    if (this.isFinished()) {
      return { success: false, error: 'Game is over' };
    }

    const row = Math.floor(index / COLS);
    const col = index % COLS;
    const cell = this.board[row][col];

    if (cell !== HIDDEN) {
      return { success: false, error: 'Cell already revealed' };
    }

    if (this.mineIndices.has(index)) {
      this.board[row][col] = MINE;
      this.winner = this.currentPlayer === 'P1' ? 'P2' : 'P1';
      return { success: true };
    }

    this.board[row][col] = SAFE;
    this.currentPlayer = this.currentPlayer === 'P1' ? 'P2' : 'P1';
    return { success: true };
  }

  getState() {
    return {
      board: this.board.map(r => [...r]),
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      isDraw: this.isDraw,
      rows: ROWS,
      cols: COLS,
      players: this.players.map(p => ({
        id: p.id,
        symbol: this.playerSymbols.get(p.id)
      }))
    };
  }

  isFinished() {
    return this.winner !== null;
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.board = null;
    this.mineIndices = null;
  }
}

module.exports = Mines;
