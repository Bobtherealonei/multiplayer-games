// topicDebate.js — "Trending in the USA" is now powered by the data-collector.
//
// Pipeline split:
//   data-collector -> writes/retires items in Firestore `newsItems`
//   this file      -> reads live items, filters out questions either player
//                     has already debated, records seen questions per user
//
// Per-user dedup: users/{uid}.seenDebateQuestions is an array of question IDs
//   (doc IDs from `newsItems`). We use arrayUnion to append after each match.

const Game = require('./game');
const { getDb, getAdmin } = require('./firestoreClient');

const TRENDING_USA_TITLE = 'Trending in the USA';
const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_POOL = 50;
const SEEN_ARRAY_CAP = 500;

const FALLBACK_QUESTIONS = [
  'Is the U.S. response to the current conflict in the Middle East the right move?',
  'Are current U.S. foreign policy decisions making America stronger or weaker?',
  'Is the media covering today\'s biggest stories fairly?',
  'Should the U.S. be more involved in what is happening internationally right now?',
  'Is the government handling the economy the right way?'
];

const trendingCache = {
  items: [],
  updatedAt: 0,
  refreshInFlight: null
};

async function refreshCacheFromFirestore() {
  const db = getDb();
  if (!db) {
    trendingCache.items = [];
    trendingCache.updatedAt = Date.now();
    return;
  }

  try {
    const snap = await db
      .collection('newsItems')
      .where('retiredAt', '==', null)
      .orderBy('publishedAt', 'desc')
      .limit(MAX_POOL)
      .get();

    const items = [];
    snap.forEach((doc) => {
      const data = doc.data();
      if (data.debateQuestion) {
        items.push({ id: doc.id, question: data.debateQuestion });
      }
    });

    trendingCache.items = items;
    trendingCache.updatedAt = Date.now();
    console.log('[TopicDebate] Loaded ' + items.length + ' live news items from Firestore');
  } catch (err) {
    console.error('[TopicDebate] Firestore fetch failed:', err.message);
  }
}

function ensureFreshCache() {
  const stale = Date.now() - trendingCache.updatedAt > CACHE_TTL_MS;
  if ((stale || !trendingCache.updatedAt) && !trendingCache.refreshInFlight) {
    trendingCache.refreshInFlight = refreshCacheFromFirestore().finally(() => {
      trendingCache.refreshInFlight = null;
    });
  }
  return trendingCache.refreshInFlight || Promise.resolve();
}

async function getSeenSet(db, userId) {
  if (!userId) return new Set();
  try {
    const doc = await db.collection('users').doc(userId).get();
    const seen = doc.exists ? (doc.data().seenDebateQuestions || []) : [];
    return new Set(seen);
  } catch (err) {
    console.warn('[TopicDebate] Could not read seen list for ' + userId + ': ' + err.message);
    return new Set();
  }
}

async function recordSeen(db, userIds, questionId) {
  if (!questionId) return;
  const admin = getAdmin();
  const fieldValue = admin.firestore.FieldValue;

  await Promise.all(
    userIds.map(async (uid) => {
      if (!uid) return;
      try {
        const ref = db.collection('users').doc(uid);
        await ref.set(
          { seenDebateQuestions: fieldValue.arrayUnion(questionId) },
          { merge: true }
        );
        const snap = await ref.get();
        const list = snap.exists ? (snap.data().seenDebateQuestions || []) : [];
        if (list.length > SEEN_ARRAY_CAP) {
          const trimmed = list.slice(-SEEN_ARRAY_CAP);
          await ref.update({ seenDebateQuestions: trimmed });
        }
      } catch (err) {
        console.warn('[TopicDebate] Could not update seen list for ' + uid + ': ' + err.message);
      }
    })
  );
}

const STATIC_TOPICS = {
  aiFuture: {
    title: 'AI and the Future',
    questions: [
      'Will AI create more jobs than it destroys over the next decade?',
      'Is AI more helpful than dangerous right now?',
      'Should AI be heavily regulated by governments?',
      'Will AI make school and college degrees less valuable?',
      'Could AI become smarter than humans in a dangerous way?',
      'Should companies have to tell you when you are talking to AI?',
      'Will AI improve daily life more than it harms privacy?',
      'Is society moving too fast with AI development?'
    ]
  },
  currentPolitics: {
    title: 'Current Politics',
    questions: [
      'Is Trump doing a good job as president?',
      'Is the U.S. government more divided than ever?',
      'Should age limits exist for presidents and members of Congress?',
      'Is the media fair in how it covers politics?',
      'Are protests an effective way to create political change?',
      'Has politics become too extreme in recent years?',
      'Should the government have more control over big tech companies?',
      'Is the country headed in the right direction politically?',
      'Should the U.S. be more involved in international conflicts?'
    ]
  },
  collegeCareers: {
    title: 'College and Careers',
    questions: [
      'Is college worth the cost anymore?',
      'Should trade school be pushed as hard as college?',
      'Is it better to follow your passion or choose a high-paying career?',
      'Is networking more important than raw talent in getting a good job?',
      'Will a college degree matter less in ten years?',
      'Should internships always be paid?',
      'Is starting your own business better than working for someone else?'
    ]
  },
  sportsDebate: {
    title: 'Sports',
    questions: [
      'Is LeBron better than Jordan?',
      'Is winning more important than sportsmanship?',
      'Should college athletes be paid?',
      'Are athletes overpaid compared to other professions?',
      'Should performance-enhancing drug users be permanently banned from their sport?',
      'Are dynasties good or bad for sports?',
      'Is football too dangerous to keep playing at the youth level?',
      'Should trash talk be considered part of the game?'
    ]
  }
};

const TRENDING_GAME_TYPE = 'religion';

function randomStaticQuestion(gameType) {
  const topic = STATIC_TOPICS[gameType];
  if (!topic) return null;
  return {
    topicKey: gameType,
    topicTitle: topic.title,
    question: topic.questions[Math.floor(Math.random() * topic.questions.length)],
    questionId: null
  };
}

async function pickTrendingQuestion(playerIds) {
  await ensureFreshCache();
  const pool = trendingCache.items;

  if (!pool.length) {
    return {
      topicKey: TRENDING_GAME_TYPE,
      topicTitle: TRENDING_USA_TITLE,
      question: FALLBACK_QUESTIONS[Math.floor(Math.random() * FALLBACK_QUESTIONS.length)],
      questionId: null
    };
  }

  const db = getDb();
  const seenSets = db
    ? await Promise.all(playerIds.map((uid) => getSeenSet(db, uid)))
    : [];

  const unseen = pool.filter((item) =>
    seenSets.every((set) => !set.has(item.id))
  );

  const picks = unseen.length ? unseen : pool;
  const chosen = picks[Math.floor(Math.random() * picks.length)];

  return {
    topicKey: TRENDING_GAME_TYPE,
    topicTitle: TRENDING_USA_TITLE,
    question: chosen.question,
    questionId: chosen.id
  };
}

class TopicDebate extends Game {
  constructor() {
    super();
    this.playerSymbols = new Map();
    this.phase = 'debating';
    this.topicKey = TRENDING_GAME_TYPE;
    this.topicTitle = TRENDING_USA_TITLE;
    this.question = 'Finding a fresh debate topic...';
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
    ensureFreshCache();
  }

  createGame(players) {
    if (players.length !== 2) throw new Error('TopicDebate requires exactly 2 players');
    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.phase = 'debating';
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
    this.createdAt = Date.now();

    const isTrending = (this.gameType || TRENDING_GAME_TYPE) === TRENDING_GAME_TYPE;

    if (!isTrending) {
      const selected = randomStaticQuestion(this.gameType);
      if (selected) {
        this.topicKey = selected.topicKey;
        this.topicTitle = selected.topicTitle;
        this.question = selected.question;
      }
    } else {
      this.topicKey = TRENDING_GAME_TYPE;
      this.topicTitle = TRENDING_USA_TITLE;
      this.question = 'Finding a fresh debate topic...';

      const playerIds = [players[0].id, players[1].id];
      pickTrendingQuestion(playerIds)
        .then(async (selected) => {
          this.question = selected.question;
          const db = getDb();
          if (db && selected.questionId) {
            await recordSeen(db, playerIds, selected.questionId);
          }
          this._broadcastState();
        })
        .catch((err) => {
          console.error('[TopicDebate] pickTrendingQuestion failed:', err.message);
          this.question = FALLBACK_QUESTIONS[Math.floor(Math.random() * FALLBACK_QUESTIONS.length)];
          this._broadcastState();
        });
    }

    return {
      success: true,
      player1: { id: players[0].id, symbol: 'P1' },
      player2: { id: players[1].id, symbol: 'P2' }
    };
  }

  _broadcastState() {
    if (!this.players) return;
    const state = this.getState();
    for (const p of this.players) {
      if (p && p.socket) {
        try { p.socket.emit('gameState', state); } catch (_) { /* ignore */ }
      }
    }
  }

  makeMove(playerId, move) {
    const sym = this.playerSymbols.get(playerId);
    if (!sym) return { success: false, error: 'Player not in this debate' };
    if (move && typeof move.readyToMatch === 'boolean') {
      this.matchRequests[sym] = move.readyToMatch;
      this.phase = (this.matchRequests.P1 && this.matchRequests.P2) ? 'matched' : 'debating';
      return { success: true };
    }
    return { success: false, error: 'Invalid debate action' };
  }

  getState() {
    return {
      board: [[this.question]],
      currentPlayer: '',
      winner: this.winner,
      isDraw: this.isDraw,
      rows: 1,
      cols: 1,
      phase: this.phase,
      topicKey: this.topicKey,
      topicTitle: this.topicTitle,
      question: this.question,
      matchRequests: { ...this.matchRequests }
    };
  }

  isFinished() { return false; }

  cleanup() {
    super.cleanup();
    this.playerSymbols.clear();
    this.phase = 'debating';
    this.question = '';
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
  }
}

ensureFreshCache();

module.exports = TopicDebate;
