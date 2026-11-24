// socialConfig.js — tunable thresholds for the social features (daily topic
// vote and its live chat now; challenges and takes add their own sections
// later).
//
// Lives in Firestore `siteSettings/social` so every number can be changed
// without an app or server release. Same pattern as experiments.js: cached
// for 30 s, and the defaults below apply to anything missing or invalid, so
// the doc doesn't have to exist at all.
//
//   siteSettings/social
//     dailyTopic: {
//       timezone:             IANA zone the topic day rolls over in
//       maxVoteChanges:       times a user may change their vote per topic
//       voteCooldownMs:       minimum gap between one user's vote requests
//       fallbackLookbackDays: window used to find the most-debated topic
//       countsBroadcastMs:    how often live counts are pushed to voters
//     }
//     chat: {
//       maxMessageLength:      server cap on one message, in characters
//       historyPageSize:       messages per page (first load and each older page)
//       slowModeSmallSeconds:  gap between one user's messages in a small room
//       slowModeMediumPeople:  people in the room at which the medium gap starts
//       slowModeMediumSeconds: gap in a medium room
//       slowModeLargePeople:   people in the room at which the large gap starts
//       slowModeLargeSeconds:  gap in a large room
//       duplicateHistory:      how many of a user's last messages a new one is compared to
//       duplicateSimilarity:   0.5–1; how alike two messages must be to count as a repeat
//       linkMinAccountAgeDays: accounts younger than this can't post links
//       reportThreshold:       distinct reporters that mute an author in the room
//       reportWindowMinutes:   window those reports must fall within
//       reportsPerUserLimit:   reports one user may file per reportWindowMinutes
//       presenceBroadcastMs:   how often the "people here now" count is pushed
//       filterAllowWords:      words the content filter should let through
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
    maxVoteChanges: { type: 'int', default: 3, range: [0, 20] },
    voteCooldownMs: { type: 'number', default: 1000, range: [0, 60 * 1000] },
    fallbackLookbackDays: { type: 'int', default: 7, range: [1, 60] },
    countsBroadcastMs: { type: 'number', default: 500, range: [100, 10 * 1000] }
  },
  chat: {
    maxMessageLength: { type: 'int', default: 5000, range: [1, 20000] },
    historyPageSize: { type: 'int', default: 50, range: [10, 200] },
    slowModeSmallSeconds: { type: 'number', default: 3, range: [0, 600] },
    slowModeMediumPeople: { type: 'int', default: 100, range: [1, 10000000] },
    slowModeMediumSeconds: { type: 'number', default: 10, range: [0, 600] },
    slowModeLargePeople: { type: 'int', default: 1000, range: [1, 10000000] },
    slowModeLargeSeconds: { type: 'number', default: 30, range: [0, 600] },
    duplicateHistory: { type: 'int', default: 3, range: [0, 20] },
    duplicateSimilarity: { type: 'number', default: 0.85, range: [0.5, 1] },
    linkMinAccountAgeDays: { type: 'number', default: 7, range: [0, 365] },
    reportThreshold: { type: 'int', default: 5, range: [1, 1000] },
    reportWindowMinutes: { type: 'number', default: 10, range: [1, 24 * 60] },
    reportsPerUserLimit: { type: 'int', default: 10, range: [1, 1000] },
    presenceBroadcastMs: { type: 'number', default: 2000, range: [250, 60 * 1000] },
    filterAllowWords: { type: 'words', default: [] }
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

async function loadSocialConfig() {
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
}

module.exports = { loadSocialConfig, normalize, DEFAULTS, _resetCacheForTests };
