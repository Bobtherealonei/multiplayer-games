const Game = require('./game');

const MIN_THRESHOLD = 9;
const MAX_THRESHOLD = 18;
const VALID_PUMPS = new Set([1, 2, 3]);

function randomThreshold() {
  return Math.floor(Math.random() * (MAX_THRESHOLD - MIN_THRESHOLD + 1)) + MIN_THRESHOLD;
}

class BalloonPump extends Game {
  constructor() {
    super();
    this.playerSymbols = new Map();
    this.phase = 'pumping';
    this.currentPlayer = 'P1';
    this.pressure = 0;
    this.threshold = randomThreshold();
    this.turnNumber = 1;
    this.lastPump = null;
    this.lastPlayer = null;
    this.history = [];
    this.winner = null;
    this.loser = null;
    this.isDraw = false;
  }

  createGame(players) {
    if (players.length !== 2) {
      throw new Error('BalloonPump requires exactly 2 players');
    }

    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.phase = 'pumping';
    this.currentPlayer = 'P1';
    this.pressure = 0;
    this.threshold = randomThreshold();
    this.turnNumber = 1;
    this.lastPump = null;
    this.lastPlayer = null;
    this.history = [];
    this.winner = null;
    this.loser = null;
    this.isDraw = false;
    this.createdAt = Date.now();

    return {
      success: true,
      player1: { id: players[0].id, symbol: 'P1' },
      player2: { id: players[1].id, symbol: 'P2' }
    };
  }

  makeMove(playerId, move) {
    const playerSymbol = this.playerSymbols.get(playerId);
    if (!playerSymbol) {
      return { success: false, error: 'Player not in this game' };
    }
    if (this.isFinished()) {
      return { success: false, error: 'Game is over' };
    }
    if (playerSymbol !== this.currentPlayer) {
      return { success: false, error: 'Not your turn' };
    }

    const pumps = Number(move?.pumps);
    if (!Number.isInteger(pumps) || !VALID_PUMPS.has(pumps)) {
      return { success: false, error: 'Choose 1, 2, or 3 pumps' };
    }

    this.pressure += pumps;
    this.lastPump = pumps;
    this.lastPlayer = playerSymbol;

    const exploded = this.pressure >= this.threshold;
    this.history.push({
      turn: this.turnNumber,
      player: playerSymbol,
      pumps,
      resultingPressure: this.pressure,
      exploded
    });

    if (exploded) {
      this.phase = 'exploded';
      this.loser = playerSymbol;
      this.winner = playerSymbol === 'P1' ? 'P2' : 'P1';
      this.currentPlayer = '';
      return { success: true };
    }

    this.currentPlayer = this.currentPlayer === 'P1' ? 'P2' : 'P1';
    this.turnNumber += 1;
    return { success: true };
  }

  getState() {
    return {
      board: [[String(this.pressure)]],
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      isDraw: this.isDraw,
      rows: 1,
      cols: 1,
      phase: this.phase,
      pressure: this.pressure,
      loser: this.loser,
      turnNumber: this.turnNumber,
      lastPump: this.lastPump,
      lastPlayer: this.lastPlayer,
      dangerLevel: Math.min(1, this.pressure / MAX_THRESHOLD),
      history: this.history.map(entry => ({ ...entry }))
    };
  }

  isFinished() {
    return this.winner !== null;
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.phase = 'pumping';
    this.currentPlayer = 'P1';
    this.pressure = 0;
    this.threshold = randomThreshold();
    this.turnNumber = 1;
    this.lastPump = null;
    this.lastPlayer = null;
    this.history = [];
    this.winner = null;
    this.loser = null;
    this.isDraw = false;
  }
}

module.exports = BalloonPump;
