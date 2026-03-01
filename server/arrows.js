const Game = require('./game');

class Arrows extends Game {
  constructor() {
    super();
    this.phase = 'player1Turn';
    this.currentPlayer = null;
    this.playerShots = new Map();
    this.scores = new Map();
    this.winner = null;
    this.readyForNextRound = new Set();
  }

  createGame(players) {
    if (players.length !== 2) throw new Error('Arrows requires exactly 2 players');
    this.players = players;
    this.phase = 'player1Turn';
    this.currentPlayer = players[0].id;
    this.playerShots.clear();
    this.scores.clear();
    this.winner = null;
    this.readyForNextRound.clear();
    this.createdAt = Date.now();
    return {
      success: true,
      player1: { id: players[0].id, symbol: 'A' },
      player2: { id: players[1].id, symbol: 'B' }
    };
  }

  makeMove(playerId, move) {
    if (!this.players.some(p => p.id === playerId)) {
      return { success: false, error: 'Player not in this game' };
    }

    const action = move.action;

    if (action === 'newRound') {
      if (this.phase !== 'finished') {
        return { success: false, error: 'Round not finished' };
      }
      this.readyForNextRound.add(playerId);
      if (this.readyForNextRound.size >= 2) {
        this.resetRound();
      }
      return { success: true };
    }

    if (action === 'shoot') {
      if (this.phase !== 'player1Turn' && this.phase !== 'player2Turn') {
        return { success: false, error: 'Not time to shoot' };
      }
      if (this.currentPlayer !== playerId) {
        return { success: false, error: 'Not your turn' };
      }
      const angle = typeof move.angle === 'number' ? move.angle : parseFloat(move.angle);
      const power = typeof move.power === 'number' ? move.power : parseFloat(move.power);
      if (isNaN(angle) || isNaN(power) || power < 0 || power > 1) {
        return { success: false, error: 'Invalid angle or power' };
      }
      this.playerShots.set(playerId, { angle, power });
      const nextPhase = this.phase === 'player1Turn' ? 'player2Turn' : 'finished';
      this.phase = nextPhase;
      this.currentPlayer = nextPhase === 'player2Turn' ? this.players[1].id : null;
      if (nextPhase === 'finished') {
        this.computeScores();
      }
      return { success: true };
    }

    return { success: false, error: 'Invalid action' };
  }

  computeScores() {
    for (const p of this.players) {
      const shot = this.playerShots.get(p.id);
      const score = shot ? shot.power : 1;
      this.scores.set(p.id, score);
    }
    const [p1, p2] = this.players;
    const s1 = this.scores.get(p1.id);
    const s2 = this.scores.get(p2.id);
    if (s1 < s2) this.winner = p1.id;
    else if (s2 < s1) this.winner = p2.id;
    else this.winner = null;
  }

  resetRound() {
    this.readyForNextRound.clear();
    this.playerShots.clear();
    this.scores.clear();
    this.winner = null;
    this.phase = 'player1Turn';
    this.currentPlayer = this.players[0].id;
  }

  getState() {
    const shots = {};
    const scores = {};
    for (const p of this.players) {
      const shot = this.playerShots.get(p.id);
      if (shot) shots[p.id] = shot;
      const score = this.scores.get(p.id);
      if (score !== undefined) scores[p.id] = score;
    }
    return {
      phase: this.phase,
      currentPlayer: this.currentPlayer,
      playerShots: shots,
      scores: Object.keys(scores).length ? scores : null,
      winner: this.winner,
      readyForNextRound: Array.from(this.readyForNextRound)
    };
  }

  isFinished() {
    return this.phase === 'finished';
  }

  cleanup() {
    super.cleanup();
    this.playerShots.clear();
    this.scores.clear();
    this.readyForNextRound.clear();
  }
}

module.exports = Arrows;
