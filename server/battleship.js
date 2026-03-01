const Game = require('./game');

const ROWS = 8;
const COLS = 8;
const SHIP_LENGTHS = [3, 2, 2];

function parseShip(ship) {
  if (!Array.isArray(ship) || ship.length === 0) return null;
  const out = [];
  for (const cell of ship) {
    if (Array.isArray(cell) && cell.length >= 2) {
      const r = Number(cell[0]);
      const c = Number(cell[1]);
      if (Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        out.push([r, c]);
      }
    }
  }
  return out.length > 0 ? out : null;
}

function validateShips(ships, rows, cols) {
  if (!Array.isArray(ships) || ships.length !== SHIP_LENGTHS.length) return false;
  const parsed = ships.map(s => parseShip(s)).filter(Boolean);
  if (parsed.length !== SHIP_LENGTHS.length) return false;

  const lengths = [...SHIP_LENGTHS].sort((a, b) => b - a);
  const sorted = parsed.slice().sort((a, b) => b.length - a.length);
  for (let i = 0; i < lengths.length; i++) {
    if (sorted[i].length !== lengths[i]) return false;
  }

  const occupied = new Set();
  for (const ship of parsed) {
    const minR = Math.min(...ship.map(([r]) => r));
    const maxR = Math.max(...ship.map(([r]) => r));
    const minC = Math.min(...ship.map(([, c]) => c));
    const maxC = Math.max(...ship.map(([, c]) => c));
    const horizontal = maxR - minR === 0 && maxC - minC === ship.length - 1;
    const vertical = maxC - minC === 0 && maxR - minR === ship.length - 1;
    if (!horizontal && !vertical) return false;
    for (const [r, c] of ship) {
      const key = `${r},${c}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }
  }
  return true;
}

class Battleship extends Game {
  constructor() {
    super();
    this.rows = ROWS;
    this.cols = COLS;
    this.phase = 'placing';
    this.currentPlayer = null;
    this.winner = null;
    this.playerShips = new Map();
    this.placeReady = new Map();
    this.shotsReceived = new Map();
    this.shotsFired = new Map();
  }

  createGame(players) {
    if (players.length !== 2) throw new Error('Battleship requires exactly 2 players');
    this.players = players;
    this.phase = 'placing';
    this.currentPlayer = null;
    this.winner = null;
    this.playerShips.clear();
    this.placeReady.clear();
    this.shotsReceived.clear();
    this.shotsFired.clear();
    for (const p of players) {
      this.placeReady.set(p.id, false);
      this.shotsReceived.set(p.id, Array(this.rows).fill(null).map(() => Array(this.cols).fill(null)));
      this.shotsFired.set(p.id, Array(this.rows).fill(null).map(() => Array(this.cols).fill(null)));
    }
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
    if (this.isFinished()) return { success: false, error: 'Game is over' };

    if (this.phase === 'placing') {
      const ships = move.ships;
      if (!validateShips(ships, this.rows, this.cols)) {
        return { success: false, error: 'Invalid ship placement' };
      }
      const shipCells = ships.map(s => parseShip(s)).filter(Boolean);
      this.playerShips.set(playerId, { ships: shipCells });
      this.placeReady.set(playerId, true);

      const bothReady = this.players.every(p => this.placeReady.get(p.id));
      if (bothReady) {
        this.phase = 'firing';
        this.currentPlayer = this.players[0].id;
      }
      return { success: true };
    }

    if (this.phase === 'firing') {
      if (this.currentPlayer !== playerId) {
        return { success: false, error: 'Not your turn' };
      }
      const row = move.row != null ? Number(move.row) : NaN;
      const col = move.col != null ? Number(move.col) : NaN;
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
        return { success: false, error: 'Invalid coordinates' };
      }
      const myShots = this.shotsFired.get(playerId);
      if (myShots[row][col] !== null) {
        return { success: false, error: 'Already shot here' };
      }
      const opponent = this.players.find(p => p.id !== playerId);
      const oppShips = this.playerShips.get(opponent.id);
      const oppReceived = this.shotsReceived.get(opponent.id);

      let hit = false;
      if (oppShips && oppShips.ships) {
        for (const ship of oppShips.ships) {
          const inShip = ship.some(([r, c]) => r === row && c === col);
          if (inShip) {
            hit = true;
            break;
          }
        }
      }
      oppReceived[row][col] = hit ? 'hit' : 'miss';
      myShots[row][col] = hit ? 'hit' : 'miss';

      if (oppShips && oppShips.ships) {
        const allSunk = oppShips.ships.every(ship =>
          ship.every(([r, c]) => oppReceived[r][c] === 'hit')
        );
        if (allSunk) this.winner = playerId;
      }
      if (!this.winner) {
        this.currentPlayer = opponent.id;
      }
      return { success: true, hit };
    }

    return { success: false, error: 'Invalid phase' };
  }

  getState() {
    const views = {};
    for (const p of this.players) {
      const pid = p.id;
      const ships = this.playerShips.get(pid);
      const hitsOnMe = this.shotsReceived.get(pid) || [];
      const myShotsOnEnemy = this.shotsFired.get(pid) || [];
      views[pid] = {
        myShips: ships ? ships.ships : [],
        hitsOnMe: hitsOnMe.map(row => [...row]),
        myShotsOnEnemy: myShotsOnEnemy.map(row => [...row])
      };
    }
    return {
      views,
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      phase: this.phase,
      rows: this.rows,
      cols: this.cols,
      player1Id: this.players[0].id,
      player2Id: this.players[1].id
    };
  }

  isFinished() {
    return this.winner !== null;
  }

  cleanup() {
    super.cleanup();
    this.playerShips.clear();
    this.placeReady.clear();
    this.shotsReceived.clear();
    this.shotsFired.clear();
  }
}

module.exports = Battleship;
