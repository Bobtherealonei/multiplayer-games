// leaderboard.js — top debaters by rank tokens (trophies).
//
// Reads users/{uid}.rankTokens via Admin SDK (clients cannot query users
// directly). Joins publicProfiles for display names and avatars.

const express = require('express');
const { getDb } = require('./firestoreClient');

const LIMIT = 10;

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

async function fetchTopDebaters() {
  const db = getDb();
  if (!db) {
    const err = new Error('Firestore unavailable');
    err.status = 503;
    throw err;
  }

  const usersSnap = await db
    .collection('users')
    .orderBy('rankTokens', 'desc')
    .limit(LIMIT)
    .get();

  if (usersSnap.empty) return [];

  const entries = [];
  const profileRefs = [];

  usersSnap.docs.forEach((doc, index) => {
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

function makeRouter() {
  const router = express.Router();

  router.get('/leaderboard', async (_req, res) => {
    try {
      const entries = await fetchTopDebaters();
      return res.json({ entries });
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      console.error('[leaderboard] error:', err.message);
      return res.status(status).json({ error: 'Could not load leaderboard' });
    }
  });

  return router;
}

module.exports = { makeRouter, fetchTopDebaters };
