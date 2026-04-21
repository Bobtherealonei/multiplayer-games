// firestoreClient.js — single Firebase Admin instance for the game server.
//
// The data-collector writes news into Firestore; this module gives the game
// server read-access to that data plus the ability to update each user's
// "seen" questions. It uses the Admin SDK so it bypasses security rules.
//
// Credentials:
//   Set env var FIREBASE_SERVICE_ACCOUNT_JSON to the full JSON contents of
//   the Firebase service-account key (from Firebase Console → Project
//   Settings → Service Accounts → Generate new private key).
//
//   Locally you can also set FIREBASE_SERVICE_ACCOUNT_PATH to a file path
//   and this module will require() it.

const admin = require('firebase-admin');

let db = null;

function getDb() {
  if (db) return db;

  if (!admin.apps.length) {
    let serviceAccount = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      } catch (err) {
        console.error('[firestoreClient] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:', err.message);
        return null;
      }
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      try {
        serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      } catch (err) {
        console.error('[firestoreClient] Could not load service account at FIREBASE_SERVICE_ACCOUNT_PATH:', err.message);
        return null;
      }
    } else {
      console.warn('[firestoreClient] No Firebase credentials set. Trending topics will use fallback questions only.');
      return null;
    }

    try {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log(`[firestoreClient] Connected to Firebase project: ${serviceAccount.project_id}`);
    } catch (err) {
      console.error('[firestoreClient] Admin init failed:', err.message);
      return null;
    }
  }

  db = admin.firestore();
  return db;
}

function getAdmin() {
  return admin;
}

module.exports = { getDb, getAdmin };
