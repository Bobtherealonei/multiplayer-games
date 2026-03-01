const Game = require('./game');

const ROWS = 8;
const COLS = 8;
const SHIP_LENGTHS = [3, 2, 2];

function cellKey(r, c) {
  return `${r},${c}`;
}

function parseShipCells(ship) {
  if (!Array.isArray(ship) || ship.length === 0) return null;
  return ship.map(cell => {
    if (Array.isArray(cell) && cell.length >= 2) return [Number(cell[0]), Number(cell[1])];
    return null;
  }).filter(Boolean);
}

function validateShips(ships, rows, cols) {
  if (!Array.isArray(ships) || ships.length !== SHIP_LENGTHS.length) return false;
  const occupied = new Set();
  const lengths = [...SHIP_LENGTHS].sort((a, b) => b - a);
  const sortedShips = ships
    .map(s => parseShipCells(s))
    .filter(s => s && s.length > 0)
    .sort((a, b) => b.length - a.length);
  if (sortedShips.length !== lengths.length) return false;

  for (let i = 0; i < lengths.length; i++) {
    const ship = sortedShips[i];
    if (!ship || ship.length !== lengths[i]) return false;
    for (const [r, c] of ship) {
      if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
      const key = cellKey(r, c);
      if (occupied.has(key)) return false;
      occupied.add(key);
    }
    const minR = Math.min(...ship.map(([r]) => r));
    const maxR = Math.max(...ship.map(([r]) => r));
    const minC = Math.min(...ship.map(([, c]) => c));
    const maxC = Math.max(...ship.map(([, c]) => c));
    const horizontal = maxR - minR === 0 && maxC - minC === ship.length - 1;
    const vertical = maxC - minC === 0 && maxR - minR === ship.length - 1;
    if (!horizontal && !vertical) return false;
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
      const cells = ships.flatMap(s => parseShipCells(s)).filter(Boolean);
      this.playerShips.set(playerId, { ships: move.ships.map(s => parseShipCells(s).filter(Boolean)) });
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
      const row = move.row;
      const col = move.col;
      if (row == null || col == null || row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
        return { success: false, error: 'Invalid coordinates' };
      }
      const opponent = this.players.find(p => p.id !== playerId);
      const myShots = this.shotsFired.get(playerId);
      if (myShots[row][col] !== null) {
        return { success: false, error: 'Already shot here' };
      }
      const oppShips = this.playerShips.get(opponent.id);
      const oppReceived = this.shotsReceived.get(opponent.id);
      let hit = false;
      let sunk = false;
      if (oppShips && oppShips.ships) {
        for (const ship of oppShips.ships) {
          const hasCell = ship.some(([r, c]) => r === row && c === col);
          if (hasCell) {
            hit = true;
            oppReceived[row][col] = 'hit';
            myShots[row][col] = 'hit';
            const shipHitCount = ship.filter(([r, c]) => oppReceived[r][c] === 'hit').length;
            if (shipHitCount === ship.length) sunk = true;
            break;
          }
        }
      }
      if (!hit) {
        oppReceived[row][col] = 'miss';
        myShots[row][col] = 'miss';
      }
      const allSunk = oppShips && oppShips.ships && oppShips.ships.every(ship =>
        ship.every(([r, c]) => oppReceived[r][c] === 'hit')
      );
      if (allSunk) {
        this.winner = playerId;
      } else {
        this.currentPlayer = opponent.id;
      }
      return { success: true, hit, sunk };
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
