// topicDebate.js — debate game backed by live-news questions for the
// "live" topics (Trending in the USA, Politics around the World, Sports) and
// a static rotation for the rest (AI, College & Careers).
//
// Pipeline split:
//   data-collector -> writes/retires items in Firestore `newsItems`, tagging
//                     each item with a `topic` (trendingUSA | politicsWorld |
//                     sports). Legacy docs without `topic` default to
//                     trendingUSA on read.
//   this file      -> reads live items, filters out questions either player
//                     has already debated, records seen questions per user.
//
// Per-user dedup: users/{uid}.seenDebateQuestions is an array of question IDs
//   (doc IDs from `newsItems`). We use arrayUnion to append after each match.
//
// State model (multi-instance scaling):
//   The class instance is EPHEMERAL — game state lives in Redis and the
//   instance is rehydrated on demand via fromState(). That lets any
//   game-server instance load a game, mutate it, save it back, and broadcast
//   an update through the Socket.IO redis-adapter, regardless of which
//   instance the players are connected to.

const Game = require('./game');
const { getDb, getAdmin } = require('./firestoreClient');

const CACHE_TTL_MS = 2 * 60 * 1000;
// Pool per topic — big on purpose. With per-user dedup against seen list,
// a larger pool means more matches before a user could revisit a question.
const MAX_POOL_PER_TOPIC = 150;
// Single Firestore query feeds all 5 topic buckets. Cap × #topics + headroom.
const FETCH_LIMIT = 1000;
// Per-user list of question IDs already shown. Bigger cap = longer the user
// can play without seeing repeats. 5000 ≈ years of debating at any sane pace.
const SEEN_ARRAY_CAP = 5000;

// ─── Live topics ──────────────────────────────────────────────────────────
// gameType -> { topic (Firestore tag), title (UI label), fallbacks (static
// safety-net questions when Firestore has nothing live for this topic) }

const LIVE_TOPIC_META = {
  // 'religion' is the legacy enum key for the "Trending in the USA" slot.
  religion: {
    topic: 'trendingUSA',
    title: 'Trending in the USA',
    fallbacks: [
      'Is the U.S. response to the current conflict in the Middle East the right move?',
      'Are current U.S. foreign policy decisions making America stronger or weaker?',
      'Is the media covering today\'s biggest stories fairly?',
      'Should the U.S. be more involved in what is happening internationally right now?',
      'Is the government handling the economy the right way?'
    ]
  },
  currentPolitics: {
    topic: 'politicsWorld',
    title: 'Politics around the World',
    fallbacks: [
      'Is the West\'s response to the war in Ukraine still the right approach?',
      'Should the U.N. have more power to step in during international conflicts?',
      'Is global democracy in decline?',
      'Are economic sanctions an effective foreign policy tool?',
      'Should countries open their borders more or close them tighter?'
    ]
  },
  sportsDebate: {
    topic: 'sports',
    title: 'Sports',
    fallbacks: [
      'Is winning more important than sportsmanship?',
      'Should college athletes be paid more?',
      'Are athletes overpaid?',
      'Should performance-enhancing drug users be permanently banned?',
      'Are dynasties good for sports?',
      'Is team loyalty more important than going where you can win?'
    ]
  },
  // aiFuture + collegeCareers don't come from RSS, but the data-collector
  // generates a rolling batch of OpenAI-written questions for them and
  // writes them into `newsItems` with the topic tag. They get the same
  // pool-from-Firestore + per-user dedup treatment as the RSS topics.
  aiFuture: {
    topic: 'aiFuture',
    title: 'AI and the Future',
    fallbacks: [
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
  custom: {
    topic: 'custom',
    title: 'Custom',
    fallbacks: [
      'Player-created debates use the question chosen when matchmaking.'
    ]
  }
};

const LIVE_GAME_TYPES = new Set(Object.keys(LIVE_TOPIC_META));
const TRENDING_GAME_TYPE = 'religion'; // legacy export kept for callers
const TRENDING_USA_TITLE = LIVE_TOPIC_META.religion.title;
const FALLBACK_QUESTIONS = LIVE_TOPIC_META.religion.fallbacks; // legacy export

// Defensive copy of the fallback rotation so any future "fully offline" code
// path (e.g. Firestore unreachable) can still serve a coherent question for
// any registered game type.
const STATIC_TOPICS = Object.fromEntries(
  Object.entries(LIVE_TOPIC_META).map(([gameType, meta]) => [
    gameType,
    { title: meta.title, questions: meta.fallbacks }
  ])
);

// ─── Live cache ───────────────────────────────────────────────────────────
// One Firestore query feeds all topic buckets — we partition the result
// in memory. That keeps us on the existing (retiredAt, publishedAt) composite
// index and avoids adding a per-topic index.

const trendingCaches = {
  trendingUSA:    { items: [] },
  politicsWorld:  { items: [] },
  sports:         { items: [] },
  aiFuture:       { items: [] },
  custom: { items: [] }
};
const cacheMeta = { updatedAt: 0, refreshInFlight: null };

async function refreshAllCachesFromFirestore() {
  const db = getDb();
  if (!db) {
    cacheMeta.updatedAt = Date.now();
    return;
  }
  try {
    const snap = await db
      .collection('newsItems')
      .where('retiredAt', '==', null)
      .orderBy('publishedAt', 'desc')
      .limit(FETCH_LIMIT)
      .get();

    const buckets = Object.fromEntries(
      Object.keys(trendingCaches).map((t) => [t, []])
    );
    snap.forEach((doc) => {
      const data = doc.data();
      if (!data.debateQuestion) return;
      // Legacy docs (pre-multi-topic) don't have a `topic` field — treat
      // them as trendingUSA so existing matches don't go empty during the
      // 24h turnover after deploy.
      const t = data.topic || 'trendingUSA';
      if (buckets[t]) {
        buckets[t].push({ id: doc.id, question: data.debateQuestion });
      }
    });

    for (const topic of Object.keys(trendingCaches)) {
      trendingCaches[topic].items = buckets[topic].slice(0, MAX_POOL_PER_TOPIC);
    }
    cacheMeta.updatedAt = Date.now();
    const summary = Object.entries(trendingCaches)
      .map(([t, c]) => `${t}=${c.items.length}`)
      .join(', ');
    console.log(`[TopicDebate] Live cache refreshed — ${summary}`);
  } catch (err) {
    console.error('[TopicDebate] Firestore fetch failed:', err.message);
    if (/util\/patterns|protobufjs/i.test(err.message)) {
      console.error(
        '[TopicDebate] Deploy protobufjs is broken — redeploy after `npm ci` in server/ (see package.json overrides). Using fallback questions only.'
      );
    }
  }
}

function ensureFreshCache() {
  const stale = Date.now() - cacheMeta.updatedAt > CACHE_TTL_MS;
  if ((stale || !cacheMeta.updatedAt) && !cacheMeta.refreshInFlight) {
    cacheMeta.refreshInFlight = refreshAllCachesFromFirestore().finally(() => {
      cacheMeta.refreshInFlight = null;
    });
  }
  return cacheMeta.refreshInFlight || Promise.resolve();
}

// ─── Per-user seen tracking ───────────────────────────────────────────────

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

// ─── Question selection ───────────────────────────────────────────────────

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

async function pickTrendingQuestion(playerIds, gameType) {
  const meta = LIVE_TOPIC_META[gameType] || LIVE_TOPIC_META[TRENDING_GAME_TYPE];
  await ensureFreshCache();
  const pool = (trendingCaches[meta.topic] || trendingCaches.trendingUSA).items;

  if (!pool.length) {
    return {
      topicKey: gameType,
      topicTitle: meta.title,
      question: meta.fallbacks[Math.floor(Math.random() * meta.fallbacks.length)],
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
    topicKey: gameType,
    topicTitle: meta.title,
    question: chosen.question,
    questionId: chosen.id
  };
}

// ─── Game class ───────────────────────────────────────────────────────────

class TopicDebate extends Game {
  constructor() {
    super();
    // All instance fields below are populated either by createGame() (fresh
    // game) or fromState() (rehydration from Redis on a different instance).
    this.gameId = null;
    this.gameType = TRENDING_GAME_TYPE;
    this.player1Id = null;
    this.player2Id = null;
    this.player1Symbol = 'P1';
    this.player2Symbol = 'P2';
    this.phase = 'debating';
    this.topicKey = TRENDING_GAME_TYPE;
    this.topicTitle = TRENDING_USA_TITLE;
    this.question = 'Finding a fresh debate topic...';
    this.questionId = null;
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
    this.createdAt = null;
    this.startedAt = null;
    this.customDebatePayload = null;
    // Position-based flow: client chose the question + each player's stance
    // before matchmaking. Populated by gameManager.createGame.
    this.preChosenMatch = null;
    this.player1Position = null;
    this.player2Position = null;
    ensureFreshCache();
  }

  // Initialise a fresh game from a pair of player IDs. Caller still has to
  // persist the result via gameStore.saveGameState().
  createGame(players) {
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error('TopicDebate requires exactly 2 players');
    }
    this.player1Id = players[0].id;
    this.player2Id = players[1].id;
    this.player1Symbol = 'P1';
    this.player2Symbol = 'P2';
    this.phase = 'debating';
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
    this.createdAt = Date.now();

    // Position-based flow takes priority: use the client-chosen question and
    // assign each player their Support/Oppose stance.
    if (this.preChosenMatch && this.preChosenMatch.question) {
      const meta = LIVE_TOPIC_META[this.gameType] || LIVE_TOPIC_META[TRENDING_GAME_TYPE];
      this.topicKey = this.gameType;
      this.topicTitle = this.preChosenMatch.topicTitle || meta.title;
      this.question = this.preChosenMatch.question;
      this.questionId = this.preChosenMatch.questionId || null;
      const positions = this.preChosenMatch.positions || {};
      this.player1Position = positions[this.player1Id] || 'support';
      this.player2Position = positions[this.player2Id] || 'oppose';
      this.preChosenMatch = null;
      return {
        success: true,
        player1: { id: this.player1Id, symbol: this.player1Symbol },
        player2: { id: this.player2Id, symbol: this.player2Symbol }
      };
    }

    if (this.gameType === 'custom' && this.customDebatePayload?.question) {
      this.topicKey = 'custom';
      this.topicTitle = this.customDebatePayload.topicTitle || 'Custom';
      this.question = this.customDebatePayload.question;
      this.customDebatePayload = null;
      return {
        success: true,
        player1: { id: this.player1Id, symbol: this.player1Symbol },
        player2: { id: this.player2Id, symbol: this.player2Symbol }
      };
    }

    const isLive = LIVE_GAME_TYPES.has(this.gameType || '') && this.gameType !== 'custom';
    if (!isLive) {
      const selected = randomStaticQuestion(this.gameType);
      if (selected) {
        this.topicKey = selected.topicKey;
        this.topicTitle = selected.topicTitle;
        this.question = selected.question;
      }
    } else {
      const meta = LIVE_TOPIC_META[this.gameType] || LIVE_TOPIC_META[TRENDING_GAME_TYPE];
      this.topicKey = this.gameType;
      this.topicTitle = meta.title;
      this.question = 'Finding a fresh debate topic...';
      // Async live fetch + broadcast is handled by gameManager so the class
      // itself stays free of Socket.IO references — that's what makes it
      // safely rehydratable on any instance.
    }

    return {
      success: true,
      player1: { id: this.player1Id, symbol: this.player1Symbol },
      player2: { id: this.player2Id, symbol: this.player2Symbol }
    };
  }

  symbolFor(playerId) {
    if (playerId === this.player1Id) return this.player1Symbol;
    if (playerId === this.player2Id) return this.player2Symbol;
    return null;
  }

  makeMove(playerId, move) {
    const sym = this.symbolFor(playerId);
    if (!sym) return { success: false, error: 'Player not in this debate' };
    if (move && typeof move.readyToMatch === 'boolean') {
      this.matchRequests[sym] = move.readyToMatch;
      this.phase = (this.matchRequests.P1 && this.matchRequests.P2) ? 'matched' : 'debating';
      return { success: true };
    }
    return { success: false, error: 'Invalid debate action' };
  }

  // Public wire format sent to clients on every gameState event.
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
      questionId: this.questionId,
      player1Position: this.player1Position,
      player2Position: this.player2Position,
      matchRequests: { ...this.matchRequests }
    };
  }

  isFinished() { return false; }

  cleanup() {
    super.cleanup();
    this.phase = 'debating';
    this.question = '';
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
  }

  // ── Persistence helpers ──────────────────────────────────────────────
  // Plain-object snapshot suitable for HSET into Redis. Anything that needs
  // to round-trip through gameStore.saveGameState() must live here.
  serialize() {
    return {
      gameId: this.gameId,
      gameType: this.gameType,
      player1Id: this.player1Id,
      player2Id: this.player2Id,
      player1Symbol: this.player1Symbol,
      player2Symbol: this.player2Symbol,
      player1Position: this.player1Position,
      player2Position: this.player2Position,
      phase: this.phase,
      topicKey: this.topicKey,
      topicTitle: this.topicTitle,
      question: this.question,
      questionId: this.questionId,
      matchRequests: this.matchRequests,
      winner: this.winner,
      isDraw: this.isDraw,
      createdAt: this.createdAt,
      startedAt: this.startedAt
    };
  }

  // Mirror of serialize(): inflate from whatever gameStore.loadGameState()
  // produced. Tolerates partial state (missing fields fall back to
  // constructor defaults) so we don't blow up on a half-written game.
  fromState(state) {
    if (!state) return this;
    this.gameId = state.gameId ?? this.gameId;
    this.gameType = state.gameType ?? this.gameType;
    this.player1Id = state.player1Id ?? null;
    this.player2Id = state.player2Id ?? null;
    this.player1Symbol = state.player1Symbol ?? 'P1';
    this.player2Symbol = state.player2Symbol ?? 'P2';
    this.player1Position = state.player1Position ?? null;
    this.player2Position = state.player2Position ?? null;
    this.phase = state.phase ?? 'debating';
    this.topicKey = state.topicKey ?? TRENDING_GAME_TYPE;
    this.topicTitle = state.topicTitle ?? TRENDING_USA_TITLE;
    this.question = state.question ?? 'Finding a fresh debate topic...';
    this.questionId = state.questionId ?? null;
    this.matchRequests = state.matchRequests ?? { P1: false, P2: false };
    this.winner = state.winner ?? null;
    this.isDraw = state.isDraw ?? false;
    this.createdAt = state.createdAt ?? null;
    this.startedAt = state.startedAt ?? null;
    return this;
  }
}

ensureFreshCache();

module.exports = TopicDebate;
module.exports.pickTrendingQuestion = pickTrendingQuestion;
module.exports.recordSeen = recordSeen;
module.exports.ensureFreshCache = ensureFreshCache;
module.exports.trendingCaches = trendingCaches;
module.exports.LIVE_GAME_TYPES = LIVE_GAME_TYPES;
module.exports.LIVE_TOPIC_META = LIVE_TOPIC_META;
module.exports.TRENDING_GAME_TYPE = TRENDING_GAME_TYPE;
module.exports.FALLBACK_QUESTIONS = FALLBACK_QUESTIONS;
