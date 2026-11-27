// socialConfig.js — tunable limits for the social features (posts,
// comments, challenges, one-on-one debates, the daily live debate, direct
// messages).
//
// Lives in Firestore `siteSettings/social` so every number can be changed
// without an app or server release. Same pattern as experiments.js: cached
// for 30 s, and the defaults below apply to anything missing or invalid, so
// the doc doesn't have to exist at all.
//
//   siteSettings/social
//     dailyTopic: {
//       timezone:             IANA zone the topic day rolls over in
//       fallbackLookbackDays: window used to find the most-debated topic
//                             when no topic was scheduled for the day
//     }
//     content: {
//       maxPostLength, maxCommentLength, maxBioLength, maxNameLength,
//       maxMessageLength:     character caps (direct messages for the last)
//       feedPageSize:         posts per page in both feeds and on profiles
//       commentsPageSize:     top-level comments per page
//       forYouWindow:         newest posts ranked for the For you tab
//       forYouHalfLifeHours:  how fast a post's score fades with age
//       postCooldownSeconds, commentCooldownSeconds, messageCooldownSeconds:
//                             minimum gap between one user's posts / comments /
//                             direct messages
//       filterAllowWords:     words the content filter should let through
//     }
//     live: {
//       messageCooldownSeconds: spam guard, gap between one user's messages
//       maxMessageLength:       characters per message
//       historyPageSize:        messages per page
//       sideCooldownMs:         minimum gap between one user's side changes
//       repeatMemory:           how many of a user's messages today are
//                               remembered to refuse an identical one
//     }
//     challenge: {
//       expiryHours:  how long a request waits for an answer
//       maxPerHour:   requests one user may send per hour
//       quoteLength:  characters of the post / comment quoted on the card
//       maxClaimLength: characters of a claim written from a profile
//     }
//     debate: {
//       rounds:                  rounds per debate (two turns each)
//       turnSeconds:             time a debater has for their turn
//       maxTurnLength:           characters per turn
//       maxAudienceLength:       characters per audience-chat message
//       audienceCooldownSeconds: gap between one spectator's messages
//     }

const { getDb } = require('./firestoreClient');
const { isValidTimeZone } = require('./timeUtil');

const CACHE_MS = 30 * 1000;

// Each setting: default, plus [min, max] for numbers. `int` settings are
// floored. Out-of-range values fall back to the default rather than being
// clamped, so a typo can't silently become a limit.
const SCHEMA = {
  dailyTopic: {
    timezone: { type: 'timezone', default: 'America/Chicago' },
    fallbackLookbackDays: { type: 'int', default: 7, range: [1, 60] }
  },
  content: {
    maxPostLength: { type: 'int', default: 500, range: [1, 5000] },
    maxCommentLength: { type: 'int', default: 500, range: [1, 5000] },
    maxBioLength: { type: 'int', default: 160, range: [0, 1000] },
    maxNameLength: { type: 'int', default: 40, range: [1, 100] },
    maxMessageLength: { type: 'int', default: 2000, range: [1, 10000] },
    feedPageSize: { type: 'int', default: 20, range: [5, 50] },
    commentsPageSize: { type: 'int', default: 20, range: [5, 50] },
    forYouWindow: { type: 'int', default: 300, range: [20, 1000] },
    forYouHalfLifeHours: { type: 'number', default: 12, range: [0.5, 24 * 14] },
    postCooldownSeconds: { type: 'number', default: 5, range: [0, 600] },
    commentCooldownSeconds: { type: 'number', default: 3, range: [0, 600] },
    messageCooldownSeconds: { type: 'number', default: 0.5, range: [0, 60] },
    filterAllowWords: { type: 'words', default: [] }
  },
  live: {
    messageCooldownSeconds: { type: 'number', default: 10, range: [0, 600] },
    maxMessageLength: { type: 'int', default: 500, range: [1, 5000] },
    historyPageSize: { type: 'int', default: 50, range: [10, 200] },
    sideCooldownMs: { type: 'number', default: 1000, range: [0, 60 * 1000] },
    repeatMemory: { type: 'int', default: 200, range: [1, 2000] }
  },
  challenge: {
    expiryHours: { type: 'number', default: 24, range: [0.01, 24 * 14] },
    maxPerHour: { type: 'int', default: 20, range: [1, 1000] },
    quoteLength: { type: 'int', default: 280, range: [20, 1000] },
    maxClaimLength: { type: 'int', default: 200, range: [10, 1000] }
  },
  debate: {
    rounds: { type: 'int', default: 3, range: [1, 10] },
    turnSeconds: { type: 'number', default: 120, range: [1, 3600] },
    maxTurnLength: { type: 'int', default: 500, range: [1, 5000] },
    maxAudienceLength: { type: 'int', default: 300, range: [1, 2000] },
    audienceCooldownSeconds: { type: 'number', default: 2, range: [0, 600] }
  }
};

function normalizeValue(spec, value) {
  switch (spec.type) {
    case 'timezone':
      return isValidTimeZone(value) ? value : spec.default;
    case 'words':
      return Array.isArray(value)
        ? value
            .filter((w) => typeof w === 'string' && w.trim())
            .map((w) => w.trim().toLowerCase())
            .slice(0, 500)
        : spec.default;
    case 'int':
    case 'number': {
      const [min, max] = spec.range;
      const ok = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
      if (!ok) return spec.default;
      return spec.type === 'int' ? Math.floor(value) : value;
    }
    default:
      return spec.default;
  }
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [section, fields] of Object.entries(SCHEMA)) {
    const given = src[section] && typeof src[section] === 'object' ? src[section] : {};
    out[section] = {};
    for (const [key, spec] of Object.entries(fields)) {
      out[section][key] = normalizeValue(spec, given[key]);
    }
  }
  return out;
}

const DEFAULTS = Object.freeze(normalize(null));

let cache = { at: 0, data: normalize(null) };
let override = null;

async function loadSocialConfig() {
  if (override) return override;
  if (Date.now() - cache.at < CACHE_MS) return cache.data;
  const db = getDb();
  if (!db) return cache.data;
  try {
    const snap = await db.doc('siteSettings/social').get();
    cache = { at: Date.now(), data: normalize(snap.exists ? snap.data() : null) };
  } catch (err) {
    console.warn('[socialConfig] load failed, using cached/default:', err.message);
    cache.at = Date.now();
  }
  return cache.data;
}

function _resetCacheForTests() {
  cache = { at: 0, data: normalize(null) };
  override = null;
}

// Tests pin the config (for example a 2-second turn) instead of writing to
// the shared settings doc.
function _setForTests(raw) {
  override = raw ? normalize(raw) : null;
}

module.exports = { loadSocialConfig, normalize, DEFAULTS, _resetCacheForTests, _setForTests };
