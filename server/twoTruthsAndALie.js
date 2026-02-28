const Game = require('./game');

const PHASE = {
  P1_SUBMIT: 'p1_submit',
  P2_GUESS: 'p2_guess',
  REVEAL1: 'reveal1',
  P2_SUBMIT: 'p2_submit',
  P1_GUESS: 'p1_guess',
  REVEAL2: 'reveal2',
  DONE: 'done'
};

class TwoTruthsAndALie extends Game {
  constructor() {
    super();
    this.phase = PHASE.P1_SUBMIT;
    this.currentPlayer = 'P1';
    this.winner = null;
    this.isDraw = false;
    this.playerSymbols = new Map();

    this.p1Statements = null;
    this.p1LieIndex = null;
    this.p2Statements = null;
    this.p2LieIndex = null;
    this.p2Guess = null;
    this.p1Guess = null;
    this.p1Correct = false;
    this.p2Correct = false;
  }

  createGame(players) {
    if (players.length !== 2) {
      throw new Error('TwoTruthsAndALie requires exactly 2 players');
    }
    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.phase = PHASE.P1_SUBMIT;
    this.currentPlayer = 'P1';
    this.winner = null;
    this.isDraw = false;
    this.p1Statements = null;
    this.p1LieIndex = null;
    this.p2Statements = null;
    this.p2LieIndex = null;
    this.p2Guess = null;
    this.p1Guess = null;
    this.p1Correct = false;
    this.p2Correct = false;
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
    const symbol = this.playerSymbols.get(playerId);

    if (this.phase === PHASE.P1_SUBMIT) {
      if (symbol !== 'P1') return { success: false, error: 'Not your turn' };
      const statements = move?.statements;
      const lieIndex = move?.lieIndex;
      if (!Array.isArray(statements) || statements.length !== 3 ||
          lieIndex === undefined || lieIndex < 0 || lieIndex > 2) {
        return { success: false, error: 'Send statements (array of 3 strings) and lieIndex (0, 1, or 2)' };
      }
      const trimmed = statements.map(s => (s != null ? String(s).trim() : ''));
      if (trimmed.some(s => !s)) return { success: false, error: 'All three statements must be non-empty' };
      this.p1Statements = trimmed;
      this.p1LieIndex = lieIndex;
      this.phase = PHASE.P2_GUESS;
      this.currentPlayer = 'P2';
      return { success: true };
    }

    if (this.phase === PHASE.P2_GUESS) {
      if (symbol !== 'P2') return { success: false, error: 'Not your turn' };
      const guess = move?.guess;
      if (guess === undefined || guess < 0 || guess > 2) {
        return { success: false, error: 'Send guess (0, 1, or 2)' };
      }
      this.p2Guess = guess;
      this.p2Correct = this.p2Guess === this.p1LieIndex;
      this.phase = PHASE.REVEAL1;
      return { success: true };
    }

    if (this.phase === PHASE.REVEAL1) {
      if (move?.next !== true && move?.continue !== true) {
        return { success: false, error: 'Tap Next to continue' };
      }
      this.phase = PHASE.P2_SUBMIT;
      this.currentPlayer = 'P2';
      return { success: true };
    }

    if (this.phase === PHASE.P2_SUBMIT) {
      if (symbol !== 'P2') return { success: false, error: 'Not your turn' };
      const statements = move?.statements;
      const lieIndex = move?.lieIndex;
      if (!Array.isArray(statements) || statements.length !== 3 ||
          lieIndex === undefined || lieIndex < 0 || lieIndex > 2) {
        return { success: false, error: 'Send statements (array of 3 strings) and lieIndex (0, 1, or 2)' };
      }
      const trimmed = statements.map(s => (s != null ? String(s).trim() : ''));
      if (trimmed.some(s => !s)) return { success: false, error: 'All three statements must be non-empty' };
      this.p2Statements = trimmed;
      this.p2LieIndex = lieIndex;
      this.phase = PHASE.P1_GUESS;
      this.currentPlayer = 'P1';
      return { success: true };
    }

    if (this.phase === PHASE.P1_GUESS) {
      if (symbol !== 'P1') return { success: false, error: 'Not your turn' };
      const guess = move?.guess;
      if (guess === undefined || guess < 0 || guess > 2) {
        return { success: false, error: 'Send guess (0, 1, or 2)' };
      }
      this.p1Guess = guess;
      this.p1Correct = this.p1Guess === this.p2LieIndex;
      this.phase = PHASE.REVEAL2;
      return { success: true };
    }

    if (this.phase === PHASE.REVEAL2) {
      if (move?.next !== true && move?.continue !== true) {
        return { success: false, error: 'Tap Next to finish' };
      }
      this.phase = PHASE.DONE;
      const p1Wins = this.p1Correct ? 1 : 0;
      const p2Wins = this.p2Correct ? 1 : 0;
      if (p1Wins > p2Wins) this.winner = 'P1';
      else if (p2Wins > p1Wins) this.winner = 'P2';
      else this.isDraw = true;
      return { success: true };
    }

    if (this.phase === PHASE.DONE) {
      return { success: false, error: 'Game is over' };
    }

    return { success: false, error: 'Invalid phase' };
  }

  getState() {
    const board = [];
    board[0] = [this.phase];
    board[1] = [null, null, null];
    board[2] = ['', ''];
    board[3] = [this.p1Correct ? '1' : '0', this.p2Correct ? '1' : '0'];

    if (this.phase === PHASE.P2_GUESS || this.phase === PHASE.REVEAL1) {
      board[1] = this.p1Statements ? [...this.p1Statements] : [null, null, null];
      if (this.phase === PHASE.REVEAL1) {
        board[2] = [this.p2Correct ? 'correct' : 'incorrect', String(this.p1LieIndex)];
      }
    }
    if (this.phase === PHASE.P1_GUESS || this.phase === PHASE.REVEAL2) {
      board[1] = this.p2Statements ? [...this.p2Statements] : [null, null, null];
      if (this.phase === PHASE.REVEAL2) {
        board[2] = [this.p1Correct ? 'correct' : 'incorrect', String(this.p2LieIndex)];
      }
    }

    return {
      board,
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      isDraw: this.isDraw,
      rows: 4,
      cols: 3,
      phase: this.phase
    };
  }

  isFinished() {
    return this.phase === PHASE.DONE;
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.p1Statements = null;
    this.p2Statements = null;
  }
}

module.exports = TwoTruthsAndALie;
