// social/core.js — shared plumbing for the social features (profiles,
// follows, posts, comments, challenges, one-on-one debates, the daily live
// debate, direct messages, notifications, reports and blocks).
//
// How the social modules work:
//   • The app never writes these collections. Every action is a Socket.IO
//     event answered through its ack; the handler checks who is asking,
//     validates the input, and writes with the Admin SDK.
//   • Live updates are Socket.IO rooms (routed across instances by the redis
//     adapter): `social:all` (every signed-in socket), `social:user:{uid}`,
//     `post:{id}`, `debate:{id}`, `live:{topicId}`.
//   • Queries only ever filter by equality / `in` and order by document id
//     (or, with no filter, by one field), so none of them needs a composite
//     index. Document ids start with the creation time in milliseconds,
//     which makes id order = time order.
//
// Every ack is `{ ok: true, ... }` or `{ ok: false, error: '<code>', ... }`.

const crypto = require('crypto');
const { getDb, getAdmin, getAuth } = require('../firestoreClient');
const { client: redis } = require('../redisClient');
const { serviceError, requireDb, publicError, unpack } = require('../socialUtil');
const { checkText } = require('../contentFilter');
const { loadSocialConfig } = require('../socialConfig');

const ID_RE = /^\d{13}-[0-9a-f]{12}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const USER_CACHE_MS = 60 * 1000;
const USER_CACHE_MAX = 10000;
const BLOCK_CACHE_MS = 30 * 1000;
const ACCOUNT_CACHE_MS = 60 * 1000;
const PERMANENT_ADMIN_EMAILS = ['jasondar83@gmail.com'];

// Only sockets that proved who they are (a verified ID token) are put in
// these rooms — see social/index.js. They are separate from the game
// server's `user:{uid}` rooms, which older, token-less builds also join.
const ROOM_ALL = 'social:all';
const userRoom = (uid) => `social:user:${uid}`;

// ── Errors ─────────────────────────────────────────────────────────────────

// An error the client is meant to see: wrong input, not allowed, too fast.
function clientError(code, extra) {
  const err = new Error(code);
  err.code = code;
  err.client = true;
  err.extra = extra || null;
  return err;
}

// ── Ids and text ───────────────────────────────────────────────────────────

function newId(nowMs = Date.now()) {
  return `${String(nowMs).padStart(13, '0')}-${crypto.randomBytes(6).toString('hex')}`;
}

const idTime = (id) => Number(String(id).slice(0, 13)) || 0;

// What gets stored: no control or invisible characters, no trailing space,
// at most one blank line in a row.
function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cleanLine = (raw) => cleanText(raw).replace(/\s+/g, ' ');
const charCount = (text) => [...text].length;
const clip = (text, max) => (typeof text === 'string' ? [...text].slice(0, max).join('') : '');

// What two messages are compared by: lowercase, no accents, no punctuation.
function comparable(text) {
  const base = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const stripped = base.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  return clip(stripped || base.replace(/\s+/g, ' ').trim(), 1000);
}

const textHash = (text) => crypto.createHash('sha1').update(comparable(text)).digest('hex').slice(0, 20);

/**
 * Cleans and checks user-written text. Throws `empty`, `too_long` or
 * `blocked_words`. `filter`: 'all' (public text), 'slurs' (private
 * messages: only slurs are refused) or 'none'.
 */
async function validText(raw, { max, min = 1, filter = 'all', singleLine = false }) {
  const text = singleLine ? cleanLine(raw) : cleanText(raw);
  const length = charCount(text);
  if (length < min) throw clientError('empty');
  if (length > max) throw clientError('too_long', { max });
  if (filter !== 'none' && text) {
    const cfg = await loadSocialConfig();
    const verdict = checkText(text, { allowWords: cfg.content.filterAllowWords });
    if (!verdict.allowed && (filter === 'all' || verdict.category === 'slur')) {
      throw clientError('blocked_words', { category: verdict.category });
    }
  }
  return text;
}

function requireId(value, code = 'bad_request') {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw clientError(code);
  return value;
}

function requireUid(value, code = 'bad_request') {
  if (typeof value !== 'string' || !UID_RE.test(value)) throw clientError(code);
  return value;
}

const optionalId = (value) => (typeof value === 'string' && ID_RE.test(value) ? value : null);

// ── Rate limits ────────────────────────────────────────────────────────────

// At most `limit` actions per `windowMs`, counted in Redis so it holds
// across instances.
async function rateLimit(name, uid, limit, windowMs) {
  const key = `rl:${name}:${uid}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, windowMs);
  if (count > limit) {
    const ttl = await redis.pttl(key);
    if (ttl < 0) await redis.pexpire(key, windowMs);
    throw clientError('rate_limited', { retryInMs: ttl > 0 ? ttl : windowMs });
  }
}

// One action per `ms`. Returns 0 when the slot was taken, otherwise how long
// is left on the current one.
async function cooldown(name, uid, ms) {
  if (ms <= 0) return 0;
  const key = `cd:${name}:${uid}`;
  const took = await redis.set(key, '1', 'PX', Math.ceil(ms), 'NX');
  if (took) return 0;
  const ttl = await redis.pttl(key);
  return ttl > 0 ? ttl : Math.ceil(ms);
}

const cooldownLeft = async (name, uid) => {
  const ttl = await redis.pttl(`cd:${name}:${uid}`);
  return ttl > 0 ? ttl : 0;
};

const clearCooldown = (name, uid) => redis.del(`cd:${name}:${uid}`);

// ── People ─────────────────────────────────────────────────────────────────

const userCache = new Map(); // uid → { at, user }

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// What every list row shows for a person.
function briefFrom(uid, data) {
  if (!data) return { id: uid, name: 'Deleted user', handle: '', avatar: null, missing: true };
  return {
    id: uid,
    name: str(data.name, 60) || str(data.username, 60) || 'Trendspark user',
    handle: str(data.username, 30) || '',
    avatar: str(data.profileImageURL || data.imageURL, 2000),
    wins: count(data.debateWins),
    losses: count(data.debateLosses)
  };
}

/** uid → brief for every uid asked for (deleted accounts included as such). */
async function getUsers(uids) {
  const out = new Map();
  const missing = [];
  const now = Date.now();
  for (const uid of new Set(uids.filter(Boolean))) {
    const hit = userCache.get(uid);
    if (hit && now - hit.at < USER_CACHE_MS) out.set(uid, hit.user);
    else missing.push(uid);
  }
  if (missing.length) {
    const db = requireDb();
    const snaps = await db.getAll(...missing.map((uid) => db.collection('publicProfiles').doc(uid)));
    if (userCache.size + missing.length > USER_CACHE_MAX) userCache.clear();
    snaps.forEach((snap, i) => {
      const user = briefFrom(missing[i], snap.exists ? snap.data() : null);
      userCache.set(missing[i], { at: now, user });
      out.set(missing[i], user);
    });
  }
  return out;
}

async function getUser(uid) {
  return (await getUsers([uid])).get(uid);
}

const forgetUser = (uid) => userCache.delete(uid);

// ── Blocks ─────────────────────────────────────────────────────────────────

const blockCache = new Map(); // uid → { at, set }

const blocksRef = (db, uid) => db.collection('users').doc(uid).collection('blocks');

/** Everyone `uid` has blocked. Cached briefly; use for filtering lists. */
async function blockedBy(uid) {
  const hit = blockCache.get(uid);
  if (hit && Date.now() - hit.at < BLOCK_CACHE_MS) return hit.set;
  const snap = await blocksRef(requireDb(), uid).select().get();
  const set = new Set(snap.docs.map((d) => d.id));
  if (blockCache.size > USER_CACHE_MAX) blockCache.clear();
  blockCache.set(uid, { at: Date.now(), set });
  return set;
}

const forgetBlocks = (uid) => blockCache.delete(uid);

/** Uncached check, for writes: has either person blocked the other? */
async function blockBetween(a, b) {
  if (!a || !b || a === b) return null;
  const db = requireDb();
  const [mine, theirs] = await db.getAll(blocksRef(db, a).doc(b), blocksRef(db, b).doc(a));
  if (theirs.exists) return 'blocked_by_them';
  if (mine.exists) return 'blocked_by_you';
  return null;
}

async function assertNoBlock(actorId, targetId) {
  const state = await blockBetween(actorId, targetId);
  if (state) throw clientError(state === 'blocked_by_you' ? 'you_blocked_them' : 'not_allowed');
}

// ── Account state ──────────────────────────────────────────────────────────

// NANP area codes that are not in the United States or its territories
// (Canada and the Caribbean share +1 with the US).
const NON_US_AREA_CODES = new Set([
  // Canada
  204, 226, 236, 249, 250, 257, 263, 289, 306, 343, 354, 365, 367, 368, 382, 387, 403, 416, 418, 428, 431, 437,
  438, 450, 460, 468, 474, 506, 514, 519, 537, 548, 568, 579, 581, 584, 587, 604, 613, 639, 647, 672, 683, 705,
  709, 742, 753, 778, 780, 782, 807, 819, 825, 851, 867, 871, 873, 879, 902, 905, 942,
  // Caribbean and Atlantic
  242, 246, 264, 268, 284, 345, 441, 473, 649, 658, 664, 721, 758, 767, 784, 809, 829, 849, 868, 869, 876
]);

/** A verified E.164 number that belongs to the US numbering plan area. */
function isUSPhone(phone) {
  const m = typeof phone === 'string' ? /^\+1([2-9]\d{2})[2-9]\d{6}$/.exec(phone) : null;
  return !!m && !NON_US_AREA_CODES.has(Number(m[1]));
}

function banState(user) {
  const until = user && user.bannedUntil;
  if (!until) return false;
  if (until === 'permanent') return true;
  const ms = typeof until.toMillis === 'function' ? until.toMillis() : Date.parse(until);
  return Number.isFinite(ms) && ms > Date.now();
}

/**
 * What the server knows about the account behind a socket: whether its
 * profile is finished, whether it is banned, whether it is an admin.
 * Read once per socket and refreshed every minute.
 */
async function loadAccount(socket, userId, { fresh = false } = {}) {
  const cached = socket.data.account;
  if (!fresh && cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached;
  const db = requireDb();
  const [userSnap, adminSnap] = await db.getAll(db.collection('users').doc(userId), db.collection('admins').doc(userId));
  const user = userSnap.exists ? userSnap.data() || {} : null;
  const email = typeof socket.data.email === 'string' ? socket.data.email.toLowerCase() : '';
  const account = {
    at: Date.now(),
    exists: !!user,
    profileComplete: !!(user && user.profileComplete === true),
    banned: banState(user),
    isAdmin: adminSnap.exists || (socket.data.emailVerified === true && PERMANENT_ADMIN_EMAILS.includes(email))
  };
  socket.data.account = account;
  return account;
}

// ── Socket handlers ────────────────────────────────────────────────────────

/**
 * Returns `on(event, handler, options)` for one socket. The handler gets the
 * payload and returns the fields of a successful ack; it throws
 * `clientError(code)` to refuse. Options:
 *   open:  true → allowed before the profile is finished (setup screens)
 *   admin: true → admins only
 */
function makeOn(socket, userId) {
  return (event, handler, options = {}) => {
    socket.on(event, async (...args) => {
      const { payload, reply } = unpack(args);
      if (!socket.data.authenticated) return reply({ ok: false, error: 'auth_required' });
      try {
        const account = await loadAccount(socket, userId);
        if (account.banned) return reply({ ok: false, error: 'banned' });
        if (!options.open && !account.profileComplete) return reply({ ok: false, error: 'profile_required' });
        if (options.admin && !account.isAdmin) return reply({ ok: false, error: 'admin_only' });
        const out = await handler(payload);
        reply({ ok: true, ...(out || {}) });
      } catch (err) {
        if (err && err.client) return reply({ ok: false, error: err.code, ...(err.extra || {}) });
        console.error(`[${event}] failed:`, (err && err.stack) || err);
        reply({ ok: false, error: publicError(err) });
      }
    });
  };
}

// Coalesces bursts: runs `fn` once per `ms` for each key.
function makeDebouncer(ms) {
  const pending = new Map();
  return (key, fn) => {
    if (pending.has(key)) return;
    const timer = setTimeout(async () => {
      pending.delete(key);
      try {
        await fn();
      } catch (err) {
        console.error('[social] debounced task failed:', err.message);
      }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(key, timer);
  };
}

const FieldValue = () => getAdmin().firestore.FieldValue;
const FieldPath = () => getAdmin().firestore.FieldPath;

module.exports = {
  ID_RE,
  UID_RE,
  HANDLE_RE,
  DAY_KEY_RE,
  ROOM_ALL,
  userRoom,
  clientError,
  serviceError,
  requireDb,
  getDb,
  getAdmin,
  getAuth,
  redis,
  FieldValue,
  FieldPath,
  loadSocialConfig,
  newId,
  idTime,
  cleanText,
  cleanLine,
  charCount,
  clip,
  comparable,
  textHash,
  validText,
  requireId,
  requireUid,
  optionalId,
  rateLimit,
  cooldown,
  cooldownLeft,
  clearCooldown,
  str,
  count,
  briefFrom,
  getUsers,
  getUser,
  forgetUser,
  blocksRef,
  blockedBy,
  forgetBlocks,
  blockBetween,
  assertNoBlock,
  isUSPhone,
  loadAccount,
  makeOn,
  makeDebouncer
};
