const Game = require('./game');

const TABLE_WIDTH = 1000;
const TABLE_HEIGHT = 560;
const BALL_RADIUS = 22;
const POCKET_RADIUS = 40;
const MIN_SPEED = 0.06;
const FRICTION = 0.9915;
const MAX_STEPS = 2200;
const FRAME_INTERVAL = 18;

const POCKETS = [
  [0, 0],
  [TABLE_WIDTH / 2, 0],
  [TABLE_WIDTH, 0],
  [0, TABLE_HEIGHT],
  [TABLE_WIDTH / 2, TABLE_HEIGHT],
  [TABLE_WIDTH, TABLE_HEIGHT]
];

function createRack() {
  const startX = TABLE_WIDTH * 0.72;
  const centerY = TABLE_HEIGHT / 2;
  const gap = BALL_RADIUS * 2.15;
  return [
    { id: 'cue', x: TABLE_WIDTH * 0.24, y: centerY, vx: 0, vy: 0, color: '#f5f5f5', pocketed: false, kind: 'cue' },
    { id: '1', x: startX, y: centerY, vx: 0, vy: 0, color: '#f7d046', pocketed: false, kind: 'object' },
    { id: '2', x: startX + gap, y: centerY - BALL_RADIUS, vx: 0, vy: 0, color: '#4aa7ff', pocketed: false, kind: 'object' },
    { id: '3', x: startX + gap, y: centerY + BALL_RADIUS, vx: 0, vy: 0, color: '#ff5d73', pocketed: false, kind: 'object' },
    { id: '4', x: startX + gap * 2, y: centerY - gap / 1.8, vx: 0, vy: 0, color: '#7d5cff', pocketed: false, kind: 'object' },
    { id: '5', x: startX + gap * 2, y: centerY + gap / 1.8, vx: 0, vy: 0, color: '#ff9340', pocketed: false, kind: 'object' }
  ];
}

function cloneBall(ball) {
  return {
    id: ball.id,
    x: Number(ball.x.toFixed(3)),
    y: Number(ball.y.toFixed(3)),
    vx: Number(ball.vx.toFixed(3)),
    vy: Number(ball.vy.toFixed(3)),
    color: ball.color,
    pocketed: Boolean(ball.pocketed),
    kind: ball.kind
  };
}

function snapshotFrame(balls) {
  return { balls: balls.map(cloneBall) };
}

function distance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function ballSpeed(ball) {
  return Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
}

function allStopped(balls) {
  return balls.every(ball => ball.pocketed || ballSpeed(ball) < MIN_SPEED);
}

function findCueBall(balls) {
  return balls.find(ball => ball.id === 'cue');
}

function respotCueBall(balls) {
  const cue = findCueBall(balls);
  if (!cue) return;

  cue.pocketed = false;
  cue.vx = 0;
  cue.vy = 0;

  let x = TABLE_WIDTH * 0.24;
  let y = TABLE_HEIGHT / 2;
  let attempts = 0;

  while (attempts < 30) {
    const collides = balls.some(ball => {
      if (ball.id === 'cue' || ball.pocketed) return false;
      return distance(x, y, ball.x, ball.y) < BALL_RADIUS * 2.2;
    });
    if (!collides) break;
    y += BALL_RADIUS * 2.3;
    if (y > TABLE_HEIGHT - BALL_RADIUS * 2) {
      y = TABLE_HEIGHT / 2 - BALL_RADIUS * attempts * 0.35;
    }
    attempts += 1;
  }

  cue.x = x;
  cue.y = y;
}

function applyWallBounce(ball) {
  if (ball.pocketed) return;

  if (ball.x < BALL_RADIUS) {
    ball.x = BALL_RADIUS;
    ball.vx = Math.abs(ball.vx) * 0.92;
  } else if (ball.x > TABLE_WIDTH - BALL_RADIUS) {
    ball.x = TABLE_WIDTH - BALL_RADIUS;
    ball.vx = -Math.abs(ball.vx) * 0.92;
  }

  if (ball.y < BALL_RADIUS) {
    ball.y = BALL_RADIUS;
    ball.vy = Math.abs(ball.vy) * 0.92;
  } else if (ball.y > TABLE_HEIGHT - BALL_RADIUS) {
    ball.y = TABLE_HEIGHT - BALL_RADIUS;
    ball.vy = -Math.abs(ball.vy) * 0.92;
  }
}

function handlePockets(balls) {
  let pocketedObjects = 0;
  let cuePocketed = false;

  for (const ball of balls) {
    if (ball.pocketed) continue;

    for (const [px, py] of POCKETS) {
      if (distance(ball.x, ball.y, px, py) <= POCKET_RADIUS) {
        ball.pocketed = true;
        ball.vx = 0;
        ball.vy = 0;
        if (ball.kind === 'cue') {
          cuePocketed = true;
        } else {
          pocketedObjects += 1;
        }
        break;
      }
    }
  }

  return { pocketedObjects, cuePocketed };
}

function resolveBallCollision(a, b) {
  if (a.pocketed || b.pocketed) return;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = BALL_RADIUS * 2;

  if (!dist || dist >= minDist) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;

  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;

  const relVx = b.vx - a.vx;
  const relVy = b.vy - a.vy;
  const separatingVelocity = relVx * nx + relVy * ny;

  if (separatingVelocity > 0) return;

  const impulse = -separatingVelocity;
  a.vx -= impulse * nx;
  a.vy -= impulse * ny;
  b.vx += impulse * nx;
  b.vy += impulse * ny;
}

function simulateShot(balls) {
  const frames = [snapshotFrame(balls)];
  let totalPocketedObjects = 0;
  let cuePocketed = false;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    for (const ball of balls) {
      if (ball.pocketed) continue;
      ball.x += ball.vx;
      ball.y += ball.vy;
    }

    for (let i = 0; i < balls.length; i += 1) {
      for (let j = i + 1; j < balls.length; j += 1) {
        resolveBallCollision(balls[i], balls[j]);
      }
    }

    for (const ball of balls) {
      applyWallBounce(ball);
    }

    const pocketResult = handlePockets(balls);
    totalPocketedObjects += pocketResult.pocketedObjects;
    cuePocketed = cuePocketed || pocketResult.cuePocketed;

    for (const ball of balls) {
      if (ball.pocketed) continue;
      ball.vx *= FRICTION;
      ball.vy *= FRICTION;
      if (Math.abs(ball.vx) < MIN_SPEED) ball.vx = 0;
      if (Math.abs(ball.vy) < MIN_SPEED) ball.vy = 0;
    }

    if (step % FRAME_INTERVAL === 0) {
      frames.push(snapshotFrame(balls));
    }

    if (allStopped(balls)) {
      break;
    }
  }

  if (cuePocketed) {
    respotCueBall(balls);
    frames.push(snapshotFrame(balls));
  }

  return {
    frames,
    pocketedObjects: totalPocketedObjects,
    cuePocketed
  };
}

class Pool extends Game {
  constructor() {
    super();
    this.playerSymbols = new Map();
    this.currentPlayer = 'P1';
    this.balls = [];
    this.score1 = 0;
    this.score2 = 0;
    this.winner = null;
    this.isDraw = false;
    this.animationFrames = [];
  }

  createGame(players) {
    if (players.length !== 2) {
      throw new Error('Pool requires exactly 2 players');
    }

    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.currentPlayer = 'P1';
    this.balls = createRack();
    this.score1 = 0;
    this.score2 = 0;
    this.winner = null;
    this.isDraw = false;
    this.animationFrames = [];
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

    const angle = Number(move?.angle);
    const power = Number(move?.power);
    if (!Number.isFinite(angle) || !Number.isFinite(power)) {
      return { success: false, error: 'Invalid shot' };
    }
    if (power < 0.2 || power > 1) {
      return { success: false, error: 'Power must be between 0.2 and 1.0' };
    }

    const cue = findCueBall(this.balls);
    if (!cue || cue.pocketed) {
      return { success: false, error: 'Cue ball is not ready' };
    }

    cue.vx = Math.cos(angle) * (power * 24);
    cue.vy = Math.sin(angle) * (power * 24);

    const result = simulateShot(this.balls);
    this.animationFrames = result.frames;

    if (playerSymbol === 'P1') {
      this.score1 += result.pocketedObjects;
    } else {
      this.score2 += result.pocketedObjects;
    }

    const remainingObjects = this.balls.filter(ball => ball.kind === 'object' && !ball.pocketed).length;
    if (remainingObjects === 0) {
      if (this.score1 === this.score2) {
        this.isDraw = true;
        this.winner = 'draw';
      } else {
        this.winner = this.score1 > this.score2 ? 'P1' : 'P2';
      }
      this.currentPlayer = '';
      return { success: true };
    }

    if (result.pocketedObjects === 0 || result.cuePocketed) {
      this.currentPlayer = this.currentPlayer === 'P1' ? 'P2' : 'P1';
    }

    return { success: true };
  }

  getState() {
    return {
      board: [[String(this.score1), String(this.score2)]],
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      isDraw: this.isDraw,
      rows: 1,
      cols: 2,
      tableWidth: TABLE_WIDTH,
      tableHeight: TABLE_HEIGHT,
      ballRadius: BALL_RADIUS,
      balls: this.balls.map(cloneBall),
      score1: this.score1,
      score2: this.score2,
      animationFrames: this.animationFrames
    };
  }

  isFinished() {
    return this.winner !== null;
  }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.currentPlayer = 'P1';
    this.balls = [];
    this.score1 = 0;
    this.score2 = 0;
    this.winner = null;
    this.isDraw = false;
    this.animationFrames = [];
  }
}

module.exports = Pool;
