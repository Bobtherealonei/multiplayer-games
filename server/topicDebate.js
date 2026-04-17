const https = require('https');
const http = require('http');
const Game = require('./game');

const TRENDING_USA_TITLE = 'Trending in the USA';
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_QUESTIONS = 10;

// Major mainstream news RSS feeds - these only ever carry hard news
const NEWS_FEEDS = [
  'https://feeds.reuters.com/reuters/topNews',
  'https://feeds.npr.org/1001/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml'
];

const FALLBACK_QUESTIONS = [
  'Is the U.S. response to the current conflict in the Middle East the right move?',
  'Is the government handling the biggest story in the news right now correctly?',
  'Are the current U.S. foreign policy decisions making America stronger or weaker?',
  "Is the media covering today's biggest story fairly?",
  'Should the U.S. be more involved in what is happening internationally right now?'
];

// Only turn a headline into a question if it is clearly major news
const HARD_NEWS_KEYWORDS = /(war|attack|missile|bomb|conflict|iran|israel|gaza|ukraine|russia|military|ceasefire|shooting|killed|dead|crisis|hostage|evacuation|election|president|trump|biden|congress|senate|supreme court|government|policy|veto|impeach|inflation|tariff|economy|recession|federal reserve|interest rate|immigration|border|deportation|sanction|nuclear|nato|china|north korea)/i;

// Block anything that is clearly entertainment or sports
const SOFT_BLOCKLIST = /(season \\d|episode|finale|trailer|netflix|hbo|disney\+|movie|film|album|song|concert|celebrity|actor|actress|nhl|nba|nfl|mlb|fifa|ufc|wwe|gaming|playstation|xbox|nintendo|anime|manga|fashion|influencer)/i;

const QUESTION_TEMPLATES = {
  war: (topic) => `Is the U.S. response to what is happening with "${topic}" the right move?`,
  politics: (topic) => `Is the government handling "${topic}" the right way?`,
  economy: (topic) => `Does what is happening with "${topic}" mean the economy is headed in the wrong direction?`,
  immigration: (topic) => `Is the U.S. approach to "${topic}" fair?`,
  international: (topic) => `Should the U.S. be more or less involved in the situation around "${topic}"?`,
  default: (topic) => `Is the public reaction to "${topic}" justified?`
};

function questionForHeadline(headline) {
  const h = headline.toLowerCase();
  if (/(war|attack|missile|bomb|conflict|iran|israel|gaza|ukraine|russia|military|ceasefire|killed|hostage|nuclear|nato)/.test(h)) {
    return QUESTION_TEMPLATES.war(headline);
  }
  if (/(immigration|border|deportation|migrant)/.test(h)) {
    return QUESTION_TEMPLATES.immigration(headline);
  }
  if (/(economy|inflation|tariff|recession|interest rate|market|stocks|jobs|federal reserve)/.test(h)) {
    return QUESTION_TEMPLATES.economy(headline);
  }
  if (/(election|president|trump|biden|congress|senate|supreme court|government|policy|veto|impeach)/.test(h)) {
    return QUESTION_TEMPLATES.politics(headline);
  }
  if (/(china|north korea|sanction|nato|international|foreign)/.test(h)) {
    return QUESTION_TEMPLATES.international(headline);
  }
  return QUESTION_TEMPLATES.default(headline);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, {
      headers: { 'User-Agent': 'TrendsparkApp/1.0 (+https://trendspark.ai)' }
    }, (response) => {
      if (response.statusCode >= 400) {
        reject(new Error('Feed returned ' + response.statusCode));
        response.resume();
        return;
      }
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve(raw));
    });
    request.on('error', reject);
    request.setTimeout(8000, () => { request.destroy(); reject(new Error('Timeout')); });
  });
}

function extractTitles(xml) {
  const results = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '').trim();
    if (!title || title.length < 12) continue;
    if (!HARD_NEWS_KEYWORDS.test(title)) continue;
    if (SOFT_BLOCKLIST.test(title)) continue;
    results.push(title);
  }
  return results;
}

const trendingCache = {
  questions: FALLBACK_QUESTIONS,
  updatedAt: 0,
  refreshInFlight: null
};

async function refreshCache() {
  if (trendingCache.refreshInFlight) return trendingCache.refreshInFlight;
  trendingCache.refreshInFlight = (async () => {
    try {
      const allTitles = [];
      for (const feedUrl of NEWS_FEEDS) {
        try {
          const xml = await fetchText(feedUrl);
          allTitles.push(...extractTitles(xml));
        } catch (feedError) {
          console.error('Feed error (' + feedUrl + '):', feedError.message);
        }
      }

      const seen = new Set();
      const deduped = [];
      for (const title of allTitles) {
        const key = title.toLowerCase().slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(title);
        if (deduped.length >= MAX_QUESTIONS) break;
      }

      if (deduped.length > 0) {
        trendingCache.questions = deduped.map(questionForHeadline);
        trendingCache.updatedAt = Date.now();
        console.log('Trending USA cache refreshed with', deduped.length, 'questions');
      } else {
        console.warn('No qualifying headlines found, keeping current cache or fallback');
        if (!trendingCache.updatedAt) {
          trendingCache.questions = FALLBACK_QUESTIONS;
        }
      }
    } catch (error) {
      console.error('Cache refresh failed:', error.message);
      if (!trendingCache.updatedAt) {
        trendingCache.questions = FALLBACK_QUESTIONS;
      }
    } finally {
      trendingCache.refreshInFlight = null;
    }
  })();
  return trendingCache.refreshInFlight;
}

function ensureCache() {
  const isStale = Date.now() - trendingCache.updatedAt > REFRESH_WINDOW_MS;
  if ((isStale || !trendingCache.updatedAt) && !trendingCache.refreshInFlight) {
    refreshCache();
  }
}

function getTrendingQuestions() {
  ensureCache();
  return trendingCache.questions.length ? trendingCache.questions : FALLBACK_QUESTIONS;
}

// ─── Static topic question banks ─────────────────────────────────────────────

const TOPICS = {
  religion: {
    title: TRENDING_USA_TITLE,
    getQuestions: getTrendingQuestions
  },
  aiFuture: {
    title: 'AI and the Future',
    questions: [
      'Will AI create more jobs than it destroys?',
      'Is AI more helpful than dangerous?',
      'Should AI be heavily regulated by governments?',
      'Will AI make schoolwork too easy for students?',
      'Could AI become smarter than humans in a dangerous way?',
      'Should people be allowed to use AI for art and music?',
      'Will AI make human relationships weaker?',
      'Should companies have to tell you when you are talking to AI?',
      'Will AI improve daily life more than it harms privacy?',
      'Is society moving too fast with AI?'
    ]
  },
  currentPolitics: {
    title: 'Current Politics',
    questions: [
      'Is Trump a good president?',
      'Is the U.S. government more divided than ever?',
      'Should age limits exist for presidents and members of Congress?',
      'Is the media fair in how it covers politics?',
      'Are protests an effective way to create political change?',
      'Has politics become too extreme in recent years?',
      'Should the government have more control over big companies?',
      'Do political parties cause more harm than good?',
      'Is the country headed in the right direction politically?',
      'Should the U.S. be more involved in international conflicts?'
    ]
  },
  collegeCareers: {
    title: 'College and Careers',
    questions: [
      'Is college worth the cost?',
      'Should trade school be pushed as much as college?',
      'Is it better to follow your passion or choose a high-paying career?',
      'Should students pick a career path earlier in life?',
      'Is networking more important than talent in getting a good job?',
      'Will college matter less in the future?',
      'Should internships always be paid?',
      'Is job stability more important than loving your work?',
      'Should success be measured more by money or happiness?',
      'Is starting your own business better than working for someone else?'
    ]
  },
  sportsDebate: {
    title: 'Sports',
    questions: [
      'Is LeBron better than Jordan?',
      'Is winning more important than sportsmanship?',
      'Should college athletes be paid more?',
      'Are referees and umpires too protected from criticism?',
      'Are athletes overpaid?',
      'Is team loyalty more important than going where you can win?',
      'Should performance-enhancing drug users be permanently banned?',
      'Are dynasties good for sports?',
      'Is football too dangerous to justify?',
      'Should trash talk be considered part of the game?'
    ]
  }
};

function randomQuestion(gameType) {
  const topic = TOPICS[gameType] || TOPICS.religion;
  const questions = typeof topic.getQuestions === 'function' ? topic.getQuestions() : topic.questions;
  const pool = questions && questions.length ? questions : FALLBACK_QUESTIONS;
  return {
    topicKey: gameType,
    topicTitle: topic.title,
    question: pool[Math.floor(Math.random() * pool.length)]
  };
}

// ─── Game class ───────────────────────────────────────────────────────────────

class TopicDebate extends Game {
  constructor() {
    super();
    this.playerSymbols = new Map();
    this.phase = 'debating';
    this.topicKey = 'religion';
    this.topicTitle = TRENDING_USA_TITLE;
    this.question = '';
    this.matchRequests = { P1: false, P2: false };
    this.winner = null;
    this.isDraw = false;
    ensureCache();
  }

  createGame(players) {
    if (players.length !== 2) throw new Error('TopicDebate requires exactly 2 players');
    this.players = players;
    this.playerSymbols.set(players[0].id, 'P1');
    this.playerSymbols.set(players[1].id, 'P2');
    this.phase = 'debating';
    const selected = randomQuestion(this.gameType);
    this.topicKey = selected.topicKey;
    this.topicTitle = selected.topicTitle;
    this.question = selected.question;
    this.matchRequests = { P1: false, P2: false };
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

ensureCache();

module.exports = TopicDebate;
