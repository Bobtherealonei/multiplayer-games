// social/profiles.js — accounts as the app sees them: the session bootstrap,
// profile creation (US-only), profile edits, profile pages, people search.
//
// Uses the collections the app has always had:
//   users/{uid}            private account doc (profileComplete, email, …)
//   publicProfiles/{uid}   name, username, bio, profileImageURL, record
//   usernames/{lowercase}  { uid } — the claim that keeps handles unique
//
// Socket events:
//   session        → me, flags (profileComplete, needsPhone, isAdmin),
//                    blocked ids, unread counts, limits
//   handleCheck    { handle }                       → { available, reason? }
//   profileCreate  { name, handle, bio, avatarURL, termsVersion }
//   profileUpdate  { name?, handle?, bio?, avatarURL? }
//   profileGet     { userId? | handle? }            → { profile }
//   userSearch     { q }                            → { users }
//   users          { ids }                          → { users }

const core = require('./core');
const notifications = require('./notifications');
const { checkText } = require('../contentFilter');

const SEARCH_LIMIT = 20;
const RESERVED_HANDLES = new Set(['admin', 'trendspark', 'support', 'moderator', 'official', 'system', 'everyone']);
const AVATAR_HOST = 'firebasestorage.googleapis.com';

const profileRef = (db, uid) => db.collection('publicProfiles').doc(uid);
const userRef = (db, uid) => db.collection('users').doc(uid);

// ── Validation ─────────────────────────────────────────────────────────────

function validHandle(raw) {
  const handle = typeof raw === 'string' ? raw.trim().replace(/^@/, '') : '';
  if (!core.HANDLE_RE.test(handle)) throw core.clientError('bad_handle');
  if (RESERVED_HANDLES.has(handle.toLowerCase())) throw core.clientError('handle_taken');
  if (!checkText(handle).allowed) throw core.clientError('blocked_words');
  return handle;
}

// An avatar must be a file the user uploaded to their own folder in this
// project's storage bucket (storage.rules only lets the owner write there).
function validAvatar(raw, uid) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 2000) throw core.clientError('bad_avatar');
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw core.clientError('bad_avatar');
  }
  const path = decodeURIComponent(url.pathname);
  const own = path.includes(`/o/profilePictures/${uid}/`) || path.endsWith(`/o/profilePictures/${uid}.jpg`);
  if (url.protocol !== 'https:' || url.hostname !== AVATAR_HOST || !own) throw core.clientError('bad_avatar');
  return raw;
}

async function validFields(payload, uid, { partial }) {
  const cfg = (await core.loadSocialConfig()).content;
  const out = {};
  if (!partial || payload.name !== undefined) {
    out.name = await core.validText(payload.name, { max: cfg.maxNameLength, singleLine: true });
  }
  if (!partial || payload.handle !== undefined) out.handle = validHandle(payload.handle);
  if (!partial || payload.bio !== undefined) {
    out.bio = await core.validText(payload.bio || '', { max: cfg.maxBioLength, min: 0 });
  }
  if (!partial || payload.avatarURL !== undefined) out.avatar = validAvatar(payload.avatarURL, uid);
  return out;
}

// ── Reads ──────────────────────────────────────────────────────────────────

async function followCounts(db, uid) {
  const [followers, following] = await Promise.all([
    profileRef(db, uid).collection('followers').count().get(),
    profileRef(db, uid).collection('following').count().get()
  ]);
  return { followers: followers.data().count, following: following.data().count };
}

async function resolveUid(db, payload) {
  if (typeof payload.userId === 'string' && core.UID_RE.test(payload.userId)) return payload.userId;
  const handle = typeof payload.handle === 'string' ? payload.handle.trim().replace(/^@/, '').toLowerCase() : '';
  if (!handle || !/^[a-z0-9_]{1,30}$/.test(handle)) throw core.clientError('not_found');
  const claim = await db.collection('usernames').doc(handle).get();
  const uid = claim.exists ? claim.get('uid') : null;
  if (!uid) throw core.clientError('not_found');
  return uid;
}

/** The profile page for `uid` as `viewerId` sees it. */
async function loadProfile(uid, viewerId) {
  const db = core.requireDb();
  const mine = viewerId === uid;
  const [snap, counts, edges, block, activeDebateId] = await Promise.all([
    profileRef(db, uid).get(),
    followCounts(db, uid),
    mine
      ? [null, null]
      : db.getAll(
          profileRef(db, uid).collection('followers').doc(viewerId),
          profileRef(db, viewerId).collection('followers').doc(uid)
        ),
    mine ? null : core.blockBetween(viewerId, uid),
    core.redis.get(`duel:active:${uid}`)
  ]);
  if (!snap.exists) throw core.clientError('not_found');
  const data = snap.data() || {};
  return {
    ...core.briefFrom(uid, data),
    bio: core.str(data.bio, 1000) || '',
    draws: core.count(data.debateDraws),
    followers: counts.followers,
    following: counts.following,
    isMe: mine,
    isFollowing: !mine && edges[0].exists,
    followsMe: !mine && edges[1].exists,
    isBlocked: block === 'blocked_by_you',
    blockedMe: block === 'blocked_by_them',
    activeDebateId: activeDebateId || null
  };
}

// Whether `viewerId` follows each of `uids` → Set of followed uids.
async function followedAmong(viewerId, uids) {
  const targets = [...new Set(uids)].filter((uid) => uid && uid !== viewerId);
  if (!targets.length) return new Set();
  const db = core.requireDb();
  const snaps = await db.getAll(...targets.map((uid) => profileRef(db, viewerId).collection('following').doc(uid)));
  return new Set(snaps.filter((s) => s.exists).map((s) => s.id));
}

async function search(viewerId, rawQuery) {
  const q = core.cleanLine(rawQuery).replace(/^@/, '').slice(0, 40);
  if (!q) return [];
  const db = core.requireDb();
  const FieldPath = core.FieldPath();
  const lower = q.toLowerCase();
  const end = '\uf8ff';

  // Handles are claimed in lowercase, so a prefix scan over the claims finds
  // them whatever the case. Names are stored as typed, so try the cases a
  // name is normally written in.
  const titled = lower.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
  const nameForms = [...new Set([q, titled, lower])];
  const handleOk = /^[a-z0-9_]+$/.test(lower);

  const [handleSnap, ...nameSnaps] = await Promise.all([
    handleOk
      ? db.collection('usernames').orderBy(FieldPath.documentId()).startAt(lower).endAt(lower + end).limit(SEARCH_LIMIT).get()
      : { docs: [] },
    ...nameForms.map((form) =>
      db.collection('publicProfiles').orderBy('name').startAt(form).endAt(form + end).limit(SEARCH_LIMIT).get()
    )
  ]);

  const uids = [];
  handleSnap.docs.forEach((d) => uids.push(d.get('uid')));
  nameSnaps.forEach((snap) => snap.docs.forEach((d) => uids.push(d.id)));

  const blocked = await core.blockedBy(viewerId);
  const unique = [...new Set(uids.filter(Boolean))].filter((uid) => !blocked.has(uid)).slice(0, SEARCH_LIMIT);
  const [users, followed] = await Promise.all([core.getUsers(unique), followedAmong(viewerId, unique)]);
  return unique
    .map((uid) => users.get(uid))
    .filter((u) => u && !u.missing && u.handle)
    .map((u) => ({ ...u, isFollowing: followed.has(u.id), isMe: u.id === viewerId }));
}

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * Saves profile fields, claiming the handle in the same transaction so two
 * people can never end up with the same one. `create` also marks the
 * account as set up.
 */
async function saveProfile(uid, fields, { create, email, termsVersion }) {
  const db = core.requireDb();
  const FieldValue = core.FieldValue();

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef(db, uid));
    const user = userSnap.exists ? userSnap.data() || {} : {};
    const oldLower = typeof user.usernameLower === 'string' ? user.usernameLower : '';

    if (fields.handle !== undefined) {
      const lower = fields.handle.toLowerCase();
      const claimRef = db.collection('usernames').doc(lower);
      const claim = await tx.get(claimRef);
      if (claim.exists && claim.get('uid') !== uid) throw core.clientError('handle_taken');
      if (oldLower && oldLower !== lower) tx.delete(db.collection('usernames').doc(oldLower));
      tx.set(claimRef, { uid, username: fields.handle, createdAt: FieldValue.serverTimestamp() });
    }

    const userUpdate = {};
    const publicUpdate = {};
    if (fields.name !== undefined) {
      userUpdate.name = fields.name;
      publicUpdate.name = fields.name;
    }
    if (fields.handle !== undefined) {
      userUpdate.username = fields.handle;
      userUpdate.usernameLower = fields.handle.toLowerCase();
      publicUpdate.username = fields.handle;
    }
    if (fields.bio !== undefined) publicUpdate.bio = fields.bio;
    if (fields.avatar !== undefined) {
      // Older app versions read `imageURL` and the `imageURLs` list; keep
      // every copy pointing at the one current photo.
      const list = fields.avatar ? [fields.avatar] : [];
      userUpdate.profileImageURL = fields.avatar;
      userUpdate.imageURL = fields.avatar;
      userUpdate.imageURLs = list;
      publicUpdate.profileImageURL = fields.avatar;
      publicUpdate.imageURL = fields.avatar;
      publicUpdate.imageURLs = list;
    }

    if (create) {
      userUpdate.profileComplete = true;
      userUpdate.country = 'US';
      userUpdate.phoneVerified = true;
      if (email) userUpdate.email = email;
      userUpdate.legalAcceptance = {
        termsVersion: core.clip(String(termsVersion || ''), 40),
        privacyVersion: core.clip(String(termsVersion || ''), 40),
        acceptedAt: FieldValue.serverTimestamp()
      };
      // Starting balances the rest of the server expects on every account.
      if (user.rankTokens === undefined) userUpdate.rankTokens = 100;
      if (user.sparkTokens === undefined) userUpdate.sparkTokens = 0;
      if (!userSnap.exists || user.createdAt === undefined) userUpdate.createdAt = FieldValue.serverTimestamp();
      publicUpdate.rankTokens = Number.isFinite(user.rankTokens) ? user.rankTokens : 100;
    }

    if (Object.keys(userUpdate).length) tx.set(userRef(db, uid), userUpdate, { merge: true });
    if (Object.keys(publicUpdate).length) tx.set(profileRef(db, uid), publicUpdate, { merge: true });
  });

  core.forgetUser(uid);
}

// ── Socket events ──────────────────────────────────────────────────────────

function register({ io, socket, on, userId }) {
  const phoneNumber = async () => {
    const auth = core.getAuth();
    if (!auth) throw core.serviceError('unavailable');
    try {
      const record = await auth.getUser(userId);
      return record.phoneNumber || null;
    } catch (err) {
      if (err && err.code === 'auth/user-not-found') return null;
      throw err;
    }
  };

  on(
    'session',
    async () => {
      const account = await core.loadAccount(socket, userId, { fresh: true });
      const cfg = await core.loadSocialConfig();
      const [me, needsPhone, blocked, unread] = await Promise.all([
        account.profileComplete ? loadProfile(userId, userId).catch(() => null) : null,
        account.profileComplete ? false : phoneNumber().then((p) => !core.isUSPhone(p)),
        core.blockedBy(userId),
        notifications.unreadCount(userId)
      ]);
      return {
        me,
        profileComplete: account.profileComplete && !!me,
        needsPhone,
        isAdmin: account.isAdmin,
        blockedIds: [...blocked],
        unreadNotifications: unread,
        limits: {
          post: cfg.content.maxPostLength,
          comment: cfg.content.maxCommentLength,
          bio: cfg.content.maxBioLength,
          name: cfg.content.maxNameLength,
          message: cfg.content.maxMessageLength,
          liveMessage: cfg.live.maxMessageLength,
          debateTurn: cfg.debate.maxTurnLength,
          audienceMessage: cfg.debate.maxAudienceLength,
          claim: cfg.challenge.maxClaimLength
        },
        serverTime: Date.now()
      };
    },
    { open: true }
  );

  on(
    'handleCheck',
    async (payload) => {
      await core.rateLimit('handleCheck', userId, 60, 60 * 1000);
      let handle;
      try {
        handle = validHandle(payload.handle);
      } catch (err) {
        return { available: false, reason: err.code };
      }
      const claim = await core.requireDb().collection('usernames').doc(handle.toLowerCase()).get();
      const available = !claim.exists || claim.get('uid') === userId;
      return { available, reason: available ? null : 'handle_taken' };
    },
    { open: true }
  );

  on(
    'profileCreate',
    async (payload) => {
      await core.rateLimit('profileCreate', userId, 10, 60 * 1000);
      const account = await core.loadAccount(socket, userId, { fresh: true });
      if (account.profileComplete) throw core.clientError('already_complete');
      if (payload.acceptedTerms !== true) throw core.clientError('terms_required');
      // US-only: the account must carry a verified US phone number.
      if (!core.isUSPhone(await phoneNumber())) throw core.clientError('us_phone_required');
      const fields = await validFields(payload, userId, { partial: false });
      await saveProfile(userId, fields, {
        create: true,
        email: socket.data.email || null,
        termsVersion: payload.termsVersion
      });
      await core.loadAccount(socket, userId, { fresh: true });
      return { me: await loadProfile(userId, userId) };
    },
    { open: true }
  );

  on('profileUpdate', async (payload) => {
    await core.rateLimit('profileUpdate', userId, 20, 60 * 1000);
    const fields = await validFields(payload, userId, { partial: true });
    if (!Object.keys(fields).length) throw core.clientError('bad_request');
    await saveProfile(userId, fields, { create: false });
    const me = await loadProfile(userId, userId);
    io.to(core.userRoom(userId)).emit('profileChanged', { me });
    return { me };
  });

  on('profileGet', async (payload) => {
    const uid = await resolveUid(core.requireDb(), payload);
    return { profile: await loadProfile(uid, userId) };
  });

  on('userSearch', async (payload) => {
    await core.rateLimit('userSearch', userId, 120, 60 * 1000);
    return { users: await search(userId, payload.q) };
  });

  // Names and avatars for a list of people (the conversation list).
  on('users', async (payload) => {
    const ids = Array.isArray(payload.ids)
      ? [...new Set(payload.ids.filter((id) => typeof id === 'string' && core.UID_RE.test(id)))].slice(0, 100)
      : [];
    const users = await core.getUsers(ids);
    return { users: ids.map((id) => users.get(id)) };
  });
}

module.exports = { register, loadProfile, followedAmong, followCounts, profileRef };
