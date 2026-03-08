const Game = require('./game');

const REVEAL_DURATION_MS = 3500;
const CHAT_DURATION_MS = 60 * 1000;

class Briefcase extends Game {
  constructor() {
    super();
    this.phase = 'choose';
    this.openerId = null;
    this.deciderId = null;
    this.briefcaseWithCheck = null;
    this.openerChoseBriefcase = null;
    this.chatStartedAt = null;
    this.deciderChoice = null;
    this.winner = null;
    this.playerSymbols = new Map();
  }

  createGame(players) {
    if (players.length !== 2) throw new Error('Briefcase requires exactly 2 players');
    this.players = players;
    this.openerId = players[0].id;
    this.deciderId = players[1].id;
    this.briefcaseWithCheck = Math.random() < 0.5 ? 0 : 1;
    this.phase = 'choose';
    this.openerChoseBriefcase = null;
    this.chatStartedAt = null;
    this.deciderChoice = null;
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

    if (this.phase === 'choose') {
      if (playerId !== this.openerId) {
        return { success: false, error: 'Only the opener can choose a briefcase' };
      }
      const choice = move.choose != null ? Number(move.choose) : null;
      if (choice !== 0 && choice !== 1) {
        return { success: false, error: 'Choose briefcase 0 or 1' };
      }
      this.openerChoseBriefcase = choice;
      this.phase = 'reveal';
      const content = this.briefcaseWithCheck === choice ? 'check' : 'x';
      const opener = this.players.find(p => p.id === this.openerId);
      if (opener && opener.socket) {
        opener.socket.emit('briefcaseReveal', { content });
      }
      return { success: true };
    }

    if (this.phase === 'reveal') {
      if (playerId !== this.openerId) return { success: false, error: 'Not your turn' };
      if (!move.readyForChat) return { success: false, error: 'Send readyForChat' };
      this.phase = 'chat';
      this.chatStartedAt = Date.now();
      return { success: true };
    }

    if (this.phase === 'chat') {
      if (playerId !== this.deciderId) {
        return { success: false, error: 'Only the decider can make the decision' };
      }
      const decision = move.decision;
      if (decision !== 'steal' && decision !== 'keep') {
        return { success: false, error: 'Invalid decision' };
      }
      this.deciderChoice = decision;
      const deciderGetsOpenerBriefcase = (decision === 'steal');
      const deciderBriefcaseIndex = deciderGetsOpenerBriefcase ? this.openerChoseBriefcase : (1 - this.openerChoseBriefcase);
      const deciderWins = (this.briefcaseWithCheck === deciderBriefcaseIndex);
      this.winner = deciderWins ? this.deciderId : this.openerId;
      this.phase = 'result';
      return { success: true };
    }

    return { success: false, error: 'Invalid phase' };
  }

  getState() {
    return {
      phase: this.phase,
      openerSymbol: this.playerSymbols.get(this.openerId) || 'P1',
      deciderSymbol: this.playerSymbols.get(this.deciderId) || 'P2',
      openerChoseBriefcase: this.openerChoseBriefcase,
      chatStartedAt: this.chatStartedAt,
      deciderChoice: this.deciderChoice,
      winner: this.winner ? this.playerSymbols.get(this.winner) : null,
      rows: 1,
      cols: 2,
      board: [[]],
      currentPlayer: '',
      isDraw: false
    };
  }

  isFinished() {
    return this.phase === 'result' && this.winner != null;
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.phase = 'choose';
    this.openerChoseBriefcase = null;
    this.chatStartedAt = null;
    this.deciderChoice = null;
    this.winner = null;
  }
}

module.exports = Briefcase;
