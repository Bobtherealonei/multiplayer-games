const Game = require('./game');

const TARGET = 10;

class FirstTo10 extends Game {
  constructor() {
    super();
    this.count1 = 0;
    this.count2 = 0;
    this.winner = null;
    this.isDraw = false;
    this.playerSymbols = new Map();
  }

  createGame(players) {
    if (players.length !== 2) {
      throw new Error('FirstTo10 requires exactly 2 players');
    }
    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.count1 = 0;
    this.count2 = 0;
    this.winner = null;
    this.isDraw = false;
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
    if (this.isFinished()) {
      return { success: false, error: 'Game is over' };
    }

    const isPlayer1 = this.players[0].id === playerId;
    if (isPlayer1) {
      this.count1 += 1;
      if (this.count1 >= TARGET) {
        this.winner = 'P1';
      }
    } else {
      this.count2 += 1;
      if (this.count2 >= TARGET) {
        this.winner = 'P2';
      }
    }

    return { success: true };
  }

  getState() {
    const board = [[String(this.count1), String(this.count2)]];
    return {
      board,
      currentPlayer: this.winner ? '' : 'P1',
      winner: this.winner,
      isDraw: this.isDraw,
      rows: 1,
      cols: 2,
      count1: this.count1,
      count2: this.count2
    };
  }

  isFinished() {
    return this.count1 >= TARGET || this.count2 >= TARGET;
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.count1 = 0;
    this.count2 = 0;
  }
}

module.exports = FirstTo10;
