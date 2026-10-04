// leaderboard.js — top debaters by rank tokens (trophies).
//
// Reads users/{uid}.rankTokens via Admin SDK (clients cannot query users
// directly). Joins publicProfiles for display names and avatars.

const express = require('express');
const { getDb } = require('./firestoreClient');

// Default stays at 10 so older app builds (which render every entry they
// receive) are unaffected; newer builds ask for `?limit=100` and page locally.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
// Extra rows pulled so internal test accounts can be dropped without
// shrinking the board below the requested size.
const TEST_ACCOUNT_SLACK = 20;

function parseLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function nameFromProfile(profile, userData, fallback) {
  if (profile && typeof profile === 'object') {
    const fromPublic = typeof profile.name === 'string' ? profile.name.trim() : '';
    if (fromPublic) return fromPublic.slice(0, 60);
  }
  if (userData && typeof userData === 'object') {
    const fromUser = typeof userData.name === 'string' ? userData.name.trim() : '';
    if (fromUser) return fromUser.slice(0, 60);
  }
  return fallback;
}

function usernameFromProfile(data) {
  if (!data || typeof data !== 'object') return null;
  const username = typeof data.username === 'string' ? data.username.trim() : '';
  return username ? username.slice(0, 60) : null;
}

function profileImageFromProfile(data) {
  if (!data || typeof data !== 'object') return null;
  const url = data.profileImageURL || data.imageURL;
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;
}

async function fetchTopDebaters(limit = DEFAULT_LIMIT) {
  const db = getDb();
  if (!db) {
    const err = new Error('Firestore unavailable');
    err.status = 503;
    throw err;
  }

  const size = parseLimit(limit);

  // Over-fetch so that internal test accounts (users/{uid}.isTestAccount)
  // can be dropped without shrinking the board below `size`. Test accounts
  // are never prize-eligible, so they must not appear in prize positions.
  const usersSnap = await db
    .collection('users')
    .orderBy('rankTokens', 'desc')
    .limit(size + TEST_ACCOUNT_SLACK)
    .get();

  if (usersSnap.empty) return [];

  const entries = [];
  const profileRefs = [];

  const eligibleDocs = usersSnap.docs
    .filter((doc) => (doc.data() || {}).isTestAccount !== true)
    .slice(0, size);

  eligibleDocs.forEach((doc, index) => {
    const data = doc.data() || {};
    const trophies = Number.isFinite(data.rankTokens) ? data.rankTokens : 0;
    entries.push({
      rank: index + 1,
      userId: doc.id,
      trophies,
      name: null,
      displayName: `Player ${index + 1}`,
      username: null,
      profileImageURL: null,
      equippedBadgeId: null,
      equippedFrameId: null,
      equippedUsernameColorId: null,
      _userData: data,
    });
    profileRefs.push(db.collection('publicProfiles').doc(doc.id));
  });

  const profileSnaps = profileRefs.length
    ? await db.getAll(...profileRefs)
    : [];

  profileSnaps.forEach((snap, index) => {
    const profile = snap.exists ? snap.data() : null;
    const userData = entries[index]._userData || null;
    const resolvedName = nameFromProfile(profile, userData, null);
    entries[index].name = resolvedName;
    entries[index].displayName = resolvedName || entries[index].displayName;
    entries[index].username = usernameFromProfile(profile);
    entries[index].profileImageURL = profileImageFromProfile(profile);
    if (profile) {
      entries[index].equippedBadgeId = profile.equippedBadgeId || null;
      entries[index].equippedFrameId = profile.equippedFrameId || null;
      entries[index].equippedUsernameColorId = profile.equippedUsernameColorId || null;
    }
    delete entries[index]._userData;
  });

  return entries;
}

// Where a single user stands overall (not just within the top 100).
// Rank = 1 + number of users with strictly more trophies, so ties share a
// rank, matching the ordering of the board itself. Uses count aggregations:
// one billed read each regardless of how many users match.
async function fetchUserRank(userId) {
  const db = getDb();
  if (!db) {
    const err = new Error('Firestore unavailable');
    err.status = 503;
    throw err;
  }

  const userSnap = await db.collection('users').doc(userId).get();
  if (!userSnap.exists) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  const data = userSnap.data() || {};
  const trophies = Number.isFinite(data.rankTokens) ? data.rankTokens : 0;

  const users = db.collection('users');
  const [aboveSnap, totalSnap] = await Promise.all([
    users.where('rankTokens', '>', trophies).count().get(),
    users.where('rankTokens', '>=', 0).count().get(),
  ]);

  return {
    userId,
    trophies,
    rank: aboveSnap.data().count + 1,
    totalPlayers: totalSnap.data().count,
  };
}

function makeRouter() {
  const router = express.Router();

  router.get('/leaderboard/rank', async (req, res) => {
    const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
    if (!userId || userId.length > 128) {
      return res.status(400).json({ error: 'userId required' });
    }
    try {
      return res.json(await fetchUserRank(userId));
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) console.error('[leaderboard] rank error:', err.message);
      return res.status(status).json({ error: 'Could not load rank' });
    }
  });

  router.get('/leaderboard', async (req, res) => {
    try {
      const entries = await fetchTopDebaters(req.query.limit);
      return res.json({ entries });
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      console.error('[leaderboard] error:', err.message);
      return res.status(status).json({ error: 'Could not load leaderboard' });
    }
  });

  return router;
}

module.exports = { makeRouter, fetchTopDebaters, fetchUserRank };
