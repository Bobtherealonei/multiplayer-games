const https = require('https');
const http = require('http');
const Game = require('./game');

const TRENDING_USA_TITLE = 'Trending in the USA';
const REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;  // refresh every 6 hours
const MAX_QUESTIONS = 15;

// Reliable mainstream news RSS feeds that always carry top global/US hard news
const NEWS_FEEDS = [
  'https://feeds.bbci.co.uk/news/rss.xml',            // BBC Top Stories
  'https://feeds.bbci.co.uk/news/world/rss.xml',      // BBC World
  'https://feeds.npr.org/1001/rss.xml',               // NPR Top Stories
  'https://www.aljazeera.com/xml/rss/all.xml',        // Al Jazeera English
  'https://feeds.feedburner.com/time/topstories',     // TIME Top Stories
];

// Fallback if all feeds fail
const FALLBACK_QUESTIONS = [
  'Is the U.S. response to the current conflict in the Middle East the right move?',
  'Are current U.S. foreign policy decisions making America stronger or weaker?',
  "Is the media covering today's biggest stories fairly?",
  'Should the U.S. be more involved in what is happening internationally right now?',
  'Is the government handling the economy the right way?'
];

// Drop only pure entertainment — NOT hard news keywords; the feeds themselves guarantee real news
const SOFT_BLOCKLIST = /(episode \d|season \d|series \d|finale|trailer|review:|netflix|hbo max|disney\+|apple tv|paramount\+|box office|\balbum\b|song lyrics|concert tour|\bcelebrity\b|kardashian|taylor swift|beyonce|selena|ariana|billie eilish|nhl|nba draft|nfl draft|mlb trade|fifa world cup group|ufc \d|wwe|video game|playstation|xbox|nintendo switch|anime|manga|fashion week|influencer|tiktok trend|viral video)/i;

const QUESTION_TEMPLATES = {
  war:       (t) => `Is the U.S. response to the situation involving "${t}" the right call?`,
  politics:  (t) => `Is the government handling the situation around "${t}" correctly?`,
  economy:   (t) => `Does what is happening with "${t}" signal that the economy is in trouble?`,
  immigration:(t)=> `Is the U.S. approach to the situation around "${t}" fair?`,
  intl:      (t) => `Should the U.S. be more or less involved in what is happening with "${t}"?`,
  default:   (t) => `Is the public reaction to "${t}" justified or overblown?`
};

function categoryForHeadline(headline) {
  const h = headline.toLowerCase();
  if (/(war|attack|airstrike|missile|bomb|explosion|conflict|iran|israel|gaza|ukraine|russia|military|ceasefire|killed|hostage|nuclear|nato|troops|soldier|invasion)/.test(h)) return 'war';
  if (/(immigration|border|migrant|deportation|asylum)/.test(h)) return 'immigration';
  if (/(economy|inflation|tariff|recession|interest rate|stock|market|federal reserve|jobs report|gdp|trade war|debt|budget|tax)/.test(h)) return 'economy';
  if (/(election|president|trump|biden|harris|congress|senate|supreme court|government|policy|veto|impeach|republican|democrat|white house|administration)/.test(h)) return 'politics';
  if (/(china|north korea|sanction|nato|un |united nations|foreign|diplomat|international|treaty|summit)/.test(h)) return 'intl';
  return 'default';
}

function questionForHeadline(headline) {
  const cat = categoryForHeadline(headline);
  // Trim the headline to a clean short topic phrase
  const topic = headline.replace(/^[A-Z]+:\s*/,'').replace(/\s*[-|]\s*BBC.*$/i,'').replace(/\s*[-|]\s*NPR.*$/i,'').replace(/\s*[-|]\s*Al Jazeera.*$/i,'').replace(/\s*[-|]\s*TIME.*$/i,'').trim();
  return QUESTION_TEMPLATES[cat](topic);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TrendsparkBot/1.0; +https://trendspark.ai)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`Feed returned ${res.statusCode}`));
        return;
      }
      // Follow redirects
      if (res.statusCode >= 300 && res.headers.location) {
        resolve(fetchText(res.headers.location));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '');
}

function extractTitles(xml) {
  const results = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const block of blocks) {
    const m = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    if (!m) continue;
    const title = decodeEntities(m[1]).trim();
    if (!title || title.length < 15) continue;
    if (SOFT_BLOCKLIST.test(title)) continue;
    results.push(title);
  }
  return results;
}

// ─── Cache ─────────────────────────────────────────────────────────────────

const trendingCache = {
  questions: FALLBACK_QUESTIONS.slice(),
  updatedAt: 0,
  refreshInFlight: null
};

async function refreshCache() {
  if (trendingCache.refreshInFlight) return trendingCache.refreshInFlight;
  trendingCache.refreshInFlight = (async () => {
    try {
      const allTitles = [];
      const feedResults = await Promise.allSettled(NEWS_FEEDS.map(fetchText));
      for (const result of feedResults) {
        if (result.status === 'fulfilled') {
          allTitles.push(...extractTitles(result.value));
        } else {
          console.warn('[TopicDebate] Feed failed:', result.reason.message);
        }
      }

      // Deduplicate by a short fingerprint
      const seen = new Set();
      const deduped = [];
      for (const title of allTitles) {
        const key = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 35);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(title);
        if (deduped.length >= MAX_QUESTIONS) break;
      }

      if (deduped.length > 0) {
        trendingCache.questions = deduped.map(questionForHeadline);
        trendingCache.updatedAt = Date.now();
        console.log(`[TopicDebate] Cache refreshed – ${deduped.length} headlines`);
        deduped.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
      } else {
        console.warn('[TopicDebate] No headlines found, keeping fallback');
        if (!trendingCache.updatedAt) trendingCache.questions = FALLBACK_QUESTIONS.slice();
      }
    } catch (err) {
      console.error('[TopicDebate] Cache refresh error:', err.message);
      if (!trendingCache.updatedAt) trendingCache.questions = FALLBACK_QUESTIONS.slice();
    } finally {
      trendingCache.refreshInFlight = null;
    }
  })();
  return trendingCache.refreshInFlight;
}

function ensureCache() {
  const stale = Date.now() - trendingCache.updatedAt > REFRESH_WINDOW_MS;
  if ((stale || !trendingCache.updatedAt) && !trendingCache.refreshInFlight) {
    refreshCache();
  }
}

function getTrendingQuestions() {
  ensureCache();
  return trendingCache.questions.length ? trendingCache.questions : FALLBACK_QUESTIONS;
}

// ─── Static topic banks ────────────────────────────────────────────────────

const TOPICS = {
  religion: {
    title: TRENDING_USA_TITLE,
    getQuestions: getTrendingQuestions
  },
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

function randomQuestion(gameType) {
  const topic = TOPICS[gameType] || TOPICS.religion;
  const questions = typeof topic.getQuestions === 'function' ? topic.getQuestions() : topic.questions;
  const pool = (questions && questions.length) ? questions : FALLBACK_QUESTIONS;
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
