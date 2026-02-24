const Game = require('./game');

const CHOICES = ['rock', 'paper', 'scissors'];

function resolveWinner(choice1, choice2) {
  if (!choice1 || !choice2) return { winner: null, isDraw: false };
  if (choice1 === choice2) return { winner: null, isDraw: true };
  const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  const firstWins = wins[choice1] === choice2;
  return { winner: firstWins ? choice1 : choice2, isDraw: false };
}

class RockPaperScissors extends Game {
  constructor() {
    super();
    this.choice1 = null;
    this.choice2 = null;
    this.winner = null;
    this.isDraw = false;
    this.playerSymbols = new Map();
  }

  createGame(players) {
    if (players.length !== 2) {
      throw new Error('RockPaperScissors requires exactly 2 players');
    }
    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.choice1 = null;
    this.choice2 = null;
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
    const choice = move?.choice;
    if (!choice || !CHOICES.includes(choice)) {
      return { success: false, error: 'Invalid choice. Use rock, paper, or scissors.' };
    }
    if (this.isFinished()) {
      return { success: false, error: 'Game is over' };
    }

    const isPlayer1 = this.players[0].id === playerId;
    if (isPlayer1) {
      if (this.choice1 !== null) return { success: false, error: 'Already chosen' };
      this.choice1 = choice;
    } else {
      if (this.choice2 !== null) return { success: false, error: 'Already chosen' };
      this.choice2 = choice;
    }

    if (this.choice1 !== null && this.choice2 !== null) {
      const result = resolveWinner(this.choice1, this.choice2);
      this.isDraw = result.isDraw;
      if (result.winner) {
        this.winner = result.winner === this.choice1 ? 'P1' : 'P2';
      } else {
        this.winner = null;
      }
    }

    return { success: true };
  }

  getState() {
    const player1Choice = this.choice1;
    const player2Choice = this.choice2;
    const board = [[player1Choice || null, player2Choice || null]];
    const currentPlayer = (player1Choice && player2Choice) ? '' : (player1Choice ? 'P2' : 'P1');
    return {
      board,
      currentPlayer,
      winner: this.winner,
      isDraw: this.isDraw,
      rows: 1,
      cols: 2,
      player1Choice: player1Choice || null,
      player2Choice: player2Choice || null
    };
  }

  isFinished() {
    return this.choice1 !== null && this.choice2 !== null;
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.choice1 = null;
    this.choice2 = null;
  }
}

module.exports = RockPaperScissors;
