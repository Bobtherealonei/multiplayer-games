const Game = require('./game');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  return shuffle(d);
}

function cardRank(card) {
  const r = (card % 13) + 1;
  return r > 10 ? 10 : r;
}

function cardValue(card) {
  const r = (card % 13) + 1;
  if (r === 1) return 11;
  return r > 10 ? 10 : r;
}

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    const v = cardValue(c);
    total += v;
    if (v === 11) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function handBusted(hand) {
  return handValue(hand) > 21;
}

class Blackjack extends Game {
  constructor() {
    super();
    this.deck = [];
    this.playerHands = new Map();
    this.playerStood = new Map();
    this.dealerHand = [];
    this.dealerHidden = true;
    this.phase = 'dealing';
    this.currentPlayer = null;
    this.results = new Map();
  }

  createGame(players) {
    if (players.length !== 2) throw new Error('Blackjack requires exactly 2 players');
    this.players = players;
    this.deck = newDeck();
    this.playerHands.clear();
    this.playerStood.clear();
    this.dealerHand = [];
    this.dealerHidden = true;
    this.phase = 'dealing';
    this.currentPlayer = null;
    this.results.clear();

    const deal = () => {
      if (this.deck.length < 6) this.deck = newDeck();
      return this.deck.pop();
    };

    for (const p of players) {
      this.playerHands.set(p.id, [deal(), deal()]);
      this.playerStood.set(p.id, false);
    }
    this.dealerHand = [deal(), deal()];
    this.dealerHidden = true;
    this.phase = 'playerTurn';
    this.currentPlayer = players[0].id;
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
    if (this.phase !== 'playerTurn') {
      return { success: false, error: 'Not your turn to act' };
    }
    if (this.currentPlayer !== playerId) {
      return { success: false, error: 'Not your turn' };
    }

    const action = move.action;
    if (action === 'stand') {
      this.playerStood.set(playerId, true);
      this.advanceTurn();
      return { success: true };
    }
    if (action === 'hit') {
      const hand = this.playerHands.get(playerId);
      if (this.deck.length < 1) this.deck = newDeck();
      hand.push(this.deck.pop());
      if (handBusted(hand)) {
        this.playerStood.set(playerId, true);
        this.advanceTurn();
      }
      return { success: true };
    }
    return { success: false, error: 'Invalid action' };
  }

  advanceTurn() {
    const next = this.players.find(p => p.id !== this.currentPlayer && !this.playerStood.get(p.id));
    if (next) {
      this.currentPlayer = next.id;
      return;
    }
    this.phase = 'dealerTurn';
    this.currentPlayer = null;
    this.dealerHidden = false;
    while (handValue(this.dealerHand) < 17) {
      if (this.deck.length < 1) this.deck = newDeck();
      this.dealerHand.push(this.deck.pop());
    }
    this.phase = 'finished';
    this.computeResults();
  }

  computeResults() {
    const dealerTotal = handValue(this.dealerHand);
    const dealerBust = handBusted(this.dealerHand);
    for (const p of this.players) {
      const hand = this.playerHands.get(p.id);
      const total = handValue(hand);
      const bust = handBusted(hand);
      if (bust) {
        this.results.set(p.id, 'lose');
      } else if (dealerBust) {
        this.results.set(p.id, 'win');
      } else if (total > dealerTotal) {
        this.results.set(p.id, 'win');
      } else if (total < dealerTotal) {
        this.results.set(p.id, 'lose');
      } else {
        this.results.set(p.id, 'push');
      }
    }
  }

  getState() {
    const playerHands = {};
    const playerStood = {};
    const playerTotals = {};
    for (const p of this.players) {
      playerHands[p.id] = this.playerHands.get(p.id) || [];
      playerStood[p.id] = this.playerStood.get(p.id) || false;
      playerTotals[p.id] = handValue(playerHands[p.id]);
    }
    let dealerVisible = this.dealerHand;
    if (this.dealerHidden && this.dealerHand.length >= 2) {
      dealerVisible = [this.dealerHand[0]];
    }
    const results = {};
    this.results.forEach((v, k) => { results[k] = v; });
    return {
      phase: this.phase,
      currentPlayer: this.currentPlayer,
      playerHands,
      playerStood,
      playerTotals,
      dealerHand: this.dealerHand,
      dealerVisible,
      dealerHidden: this.dealerHidden,
      dealerTotal: this.dealerHidden ? null : handValue(this.dealerHand),
      results: Object.keys(results).length ? results : null
    };
  }

  isFinished() {
    return this.phase === 'finished';
  }

  cleanup() {
    super.cleanup();
    this.playerHands.clear();
    this.playerStood.clear();
    this.results.clear();
  }
}

module.exports = Blackjack;
