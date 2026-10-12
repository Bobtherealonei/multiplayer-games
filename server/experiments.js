// experiments.js — feature gates for things we're testing with a few accounts
// before rolling them out. Config lives in Firestore `siteSettings/experiments`
// (editable from the admin panel) and is cached briefly so matchmaking doesn't
// hit Firestore on every pairing.
//
//   sideSelectForAll:   boolean — enable private side selection for every
//                       client that supports it (default false)
//   sideSelectTesters:  [uid]   — accounts that get it while ForAll is off
//
// A client also has to ADVERTISE support (`sideSelect=1` in the socket
// handshake) — older builds ignore the lobby events and would hang.

const { getDb } = require('./firestoreClient');

const CACHE_MS = 30 * 1000;
let cache = { at: 0, data: null };

async function loadExperiments() {
  if (Date.now() - cache.at < CACHE_MS) return cache.data || {};
  const db = getDb();
  if (!db) return cache.data || {};
  try {
    const snap = await db.doc('siteSettings/experiments').get();
    cache = { at: Date.now(), data: snap.exists ? snap.data() || {} : {} };
  } catch (err) {
    console.warn('[experiments] load failed, using cached/default:', err.message);
    cache.at = Date.now();
  }
  return cache.data || {};
}

// Env override for local testing without touching Firestore.
const ENV_TESTERS = String(process.env.SIDE_SELECT_TESTERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ENV_FOR_ALL = process.env.SIDE_SELECT_FOR_ALL === 'true';

/**
 * True when this user should get the private side-selection lobby:
 * their app supports it AND they're allowlisted (or it's on for everyone).
 */
async function sideSelectEnabledFor(userId, caps) {
  if (!caps || caps.sideSelect !== true) return false;
  if (ENV_FOR_ALL) return true;
  if (ENV_TESTERS.includes(userId)) return true;
  const exp = await loadExperiments();
  if (exp.sideSelectForAll === true) return true;
  const testers = Array.isArray(exp.sideSelectTesters) ? exp.sideSelectTesters : [];
  return testers.includes(userId);
}

function _resetCacheForTests() {
  cache = { at: 0, data: null };
}

module.exports = { sideSelectEnabledFor, loadExperiments, _resetCacheForTests };
