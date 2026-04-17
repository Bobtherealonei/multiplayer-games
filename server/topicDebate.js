const https = require('https');
const Game = require('./game');

const TRENDING_USA_TITLE = 'Trending in the USA';
const TRENDING_USA_RSS = 'https://trends.google.com/trending/rss?geo=US';
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
const RECENT_NEWS_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_TREND_QUESTIONS = 12;

const FALLBACK_TRENDING_QUESTIONS = [
  'Based on the biggest stories in the U.S. right now, is the public reaction justified?',
  'Is the latest trending news in the U.S. being handled the right way?',
  'Are the biggest U.S. headlines right now genuinely important, or just overhyped?',
  "Is social media helping people understand today's top U.S. stories, or just making them louder?",
  "Will today's biggest U.S. news still matter next week, or is it just a short-term trend?"
];

const TOPICS = {
  religion: {
    title: TRENDING_USA_TITLE,
    getQuestions: () => getTrendingUSAQuestions()
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
      'Is Biden too old to be president?',
      'Is the U.S. government more divided than ever?',
      'Should age limits exist for presidents and members of Congress?',
      'Is the media fair in how it covers politics?',
      'Are protests an effective way to create political change?',
      'Has politics become too extreme in recent years?',
      'Should the government have more control over big companies?',
      'Do political parties cause more harm than good?',
      'Is the country headed in the right direction politically?'
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

const trendingCache = {
  title: TRENDING_USA_TITLE,
  questions: FALLBACK_TRENDING_QUESTIONS,
  updatedAt: 0,
  refreshInFlight: null
};

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractTagContent(xml, tagName) {
  const regex = new RegExp(String.raw`<${tagName}>([\s\S]*?)</${tagName}>`, 'g');
  const values = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    values.push(decodeXmlEntities(match[1].trim()));
  }
  return values;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`Trend feed request failed with status ${response.statusCode}`));
          response.resume();
          return;
        }

        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => resolve(raw));
      })
      .on('error', reject);
  });
}

function normalizeTopic(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function buildNewsBackedQuestion(trend, headlines) {
  const cleanTrend = normalizeTopic(trend);
  const primaryHeadline = normalizeTopic((headlines && headlines[0]) || '');
  const context = `${cleanTrend} ${headlines.join(' ')}`.toLowerCase();

  if (/(war|attack|missile|bomb|conflict|iran|israel|gaza|ukraine|military)/.test(context)) {
    return `Based on the latest news around "${cleanTrend}", is the current response to the conflict the right move?`;
  }

  if (/(election|president|senate|senator|congress|government|policy|bill|veto|supreme court|politic)/.test(context)) {
    return `Based on the latest news around "${cleanTrend}", is the government response helping more than hurting?`;
  }

  if (/(economy|inflation|tariff|market|stocks|jobs|trade|prices|recession)/.test(context)) {
    return `Does the latest news around "${cleanTrend}" suggest the economy is moving in the right direction?`;
  }

  if (/(vs\.| vs |playoff|finale|game|season|trade deadline|draft|championship)/.test(context)) {
    return `Does "${cleanTrend}" deserve to be one of the biggest sports stories in the U.S. right now?`;
  }

  if (primaryHeadline) {
    return `After "${primaryHeadline}", is the reaction to "${cleanTrend}" justified?`;
  }

  return `Based on the latest news around "${cleanTrend}", is all the attention justified right now?`;
}

function parseTrendItems(xml) {
  const now = Date.now();
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

  return itemBlocks
    .map((item) => {
      const trend = extractTagContent(item, 'title')[0];
      const pubDateRaw = extractTagContent(item, 'pubDate')[0];
      const headlines = extractTagContent(item, 'ht:news_item_title')
        .map((headline) => headline.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim())
        .filter(Boolean);
      const publishedAt = pubDateRaw ? Date.parse(pubDateRaw) : NaN;
      return {
        trend: trend ? trend.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '',
        headlines,
        publishedAt: Number.isNaN(publishedAt) ? now : publishedAt
      };
    })
    .filter((item) => item.trend)
    .filter((item) => now - item.publishedAt <= RECENT_NEWS_WINDOW_MS);
}

async function refreshTrendingUSACache() {
  if (trendingCache.refreshInFlight) {
    return trendingCache.refreshInFlight;
  }

  trendingCache.refreshInFlight = (async () => {
    try {
      const xml = await fetchText(TRENDING_USA_RSS);
      const items = parseTrendItems(xml);
      const deduped = [];
      const seen = new Set();

      for (const item of items) {
        const key = item.trend.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        deduped.push(item);
        if (deduped.length >= MAX_TREND_QUESTIONS) {
          break;
        }
      }

      const generatedQuestions = deduped
        .map((item) => buildNewsBackedQuestion(item.trend, item.headlines))
        .filter(Boolean);

      if (generatedQuestions.length > 0) {
        trendingCache.questions = generatedQuestions;
        trendingCache.updatedAt = Date.now();
      }
    } catch (error) {
      console.error('Trending USA refresh failed:', error.message);
      if (!trendingCache.updatedAt) {
        trendingCache.questions = FALLBACK_TRENDING_QUESTIONS;
      }
    } finally {
      trendingCache.refreshInFlight = null;
    }
  })();

  return trendingCache.refreshInFlight;
}

function ensureTrendingUSACache() {
  const isStale = Date.now() - trendingCache.updatedAt > REFRESH_WINDOW_MS;
  const hasNoQuestions = !Array.isArray(trendingCache.questions) || trendingCache.questions.length === 0;
  if ((isStale || hasNoQuestions) && !trendingCache.refreshInFlight) {
    refreshTrendingUSACache();
  }
}

function getTrendingUSAQuestions() {
  ensureTrendingUSACache();
  return trendingCache.questions.length ? trendingCache.questions : FALLBACK_TRENDING_QUESTIONS;
}

function randomQuestion(gameType) {
  const topic = TOPICS[gameType] || TOPICS.religion;
  const questions = typeof topic.getQuestions === 'function' ? topic.getQuestions() : topic.questions;
  const sourceQuestions = questions && questions.length ? questions : FALLBACK_TRENDING_QUESTIONS;
  const index = Math.floor(Math.random() * sourceQuestions.length);
  return {
    topicKey: gameType,
    topicTitle: topic.title,
    question: sourceQuestions[index]
  };
}

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
    ensureTrendingUSACache();
  }

  createGame(players) {
    if (players.length !== 2) {
      throw new Error('TopicDebate requires exactly 2 players');
    }

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
    const playerSymbol = this.playerSymbols.get(playerId);
    if (!playerSymbol) {
      return { success: false, error: 'Player not in this debate' };
    }

    if (move && typeof move.readyToMatch === 'boolean') {
      this.matchRequests[playerSymbol] = move.readyToMatch;
      if (this.matchRequests.P1 && this.matchRequests.P2) {
        this.phase = 'matched';
      } else {
        this.phase = 'debating';
      }
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

  isFinished() {
    return false;
  }

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

ensureTrendingUSACache();

module.exports = TopicDebate;
