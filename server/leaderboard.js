// leaderboard.js — top debaters by rank tokens (trophies).
//
// Reads users/{uid}.rankTokens via Admin SDK (clients cannot query users
// directly). Joins publicProfiles for display names and avatars.

const express = require('express');
const { getDb } = require('./firestoreClient');

const LIMIT = 10;

function displayNameFromProfile(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  const username = typeof data.username === 'string' ? data.username.trim() : '';
  if (username) return username.slice(0, 60);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (name) return name.slice(0, 60);
  return fallback;
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
      username: `Player ${index + 1}`,
      profileImageURL: null,
    });
    profileRefs.push(db.collection('publicProfiles').doc(doc.id));
  });

  const profileSnaps = profileRefs.length
    ? await db.getAll(...profileRefs)
    : [];

  profileSnaps.forEach((snap, index) => {
    const profile = snap.exists ? snap.data() : null;
    entries[index].username = displayNameFromProfile(profile, entries[index].username);
    entries[index].profileImageURL = profileImageFromProfile(profile);
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
