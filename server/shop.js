// shop.js — secure Spark Shop purchase endpoint.
//
// SECURITY MODEL (mirrors rewards.js)
//   The client never chooses a price or edits its own Spark balance. It only
//   sends an itemId + a Firebase ID token. The server verifies the token,
//   reads the OFFICIAL price from shopItems/{itemId}, and inside a single
//   Firestore transaction:
//     1. confirms the item still exists / is available,
//     2. confirms the user can afford it,
//     3. confirms the user doesn't already own it,
//     4. subtracts Spark tokens,
//     5. adds the item to users/{uid}/inventory,
//     6. records a tokenHistory entry,
//     7. prevents duplicate purchases (inventory doc id == itemId).

const express = require('express');
const { getDb, getAdmin, getAuth } = require('./firestoreClient');

function makeRouter() {
  const router = express.Router();

  router.post('/purchase', async (req, res) => {
    const { itemId, idToken } = req.body || {};
    if (!itemId || typeof itemId !== 'string') {
      return res.status(400).json({ error: 'itemId is required' });
    }

    const auth = getAuth();
    if (!auth) return res.status(500).json({ error: 'Auth unavailable' });
    let uid;
    try {
      const decoded = await auth.verifyIdToken(String(idToken || ''));
      uid = decoded.uid;
    } catch (err) {
      return res.status(401).json({ error: 'Invalid auth token' });
    }

    const db = getDb();
    if (!db) return res.status(500).json({ error: 'Firestore unavailable' });
    const admin = getAdmin();
    const FieldValue = admin.firestore.FieldValue;

    const itemRef = db.collection('shopItems').doc(itemId);
    const userRef = db.collection('users').doc(uid);
    const invRef = userRef.collection('inventory').doc(itemId);

    try {
      const result = await db.runTransaction(async (tx) => {
        const [itemSnap, userSnap, invSnap] = await Promise.all([
          tx.get(itemRef), tx.get(userRef), tx.get(invRef)
        ]);

        if (!itemSnap.exists) {
          return { ok: false, code: 'item_unavailable' };
        }
        const item = itemSnap.data();

        // Expired / time-limited item check.
        if (item.availableUntil && Number(item.availableUntil) < Date.now()) {
          return { ok: false, code: 'item_expired' };
        }

        if (invSnap.exists) {
          return { ok: false, code: 'already_owned' };
        }

        const price = Number(item.price);
        if (!Number.isFinite(price) || price < 0) {
          return { ok: false, code: 'invalid_price' };
        }

        const current = userSnap.exists ? userSnap.data() : {};
        const spark = Number.isFinite(current.sparkTokens) ? current.sparkTokens : 0;
        if (spark < price) {
          return { ok: false, code: 'insufficient_funds', sparkTokens: spark };
        }

        const newSpark = spark - price;
        tx.set(userRef, { sparkTokens: newSpark }, { merge: true });

        tx.set(invRef, {
          itemId,
          category: item.category || null,
          purchasedAt: FieldValue.serverTimestamp(),
          purchasePrice: price,
          isEquipped: false
        });

        const histRef = userRef.collection('tokenHistory').doc();
        tx.set(histRef, {
          tokenType: 'spark',
          amount: -price,
          reason: 'shop_purchase',
          itemId,
          timestamp: FieldValue.serverTimestamp()
        });

        return { ok: true, sparkTokens: newSpark, category: item.category, itemId };
      });

      if (result.ok) {
        return res.json({ status: 'purchased', sparkTokens: result.sparkTokens, itemId: result.itemId, category: result.category });
      }
      switch (result.code) {
        case 'item_unavailable': return res.status(404).json({ error: 'Item unavailable', code: result.code });
        case 'item_expired':     return res.status(409).json({ error: 'Item expired', code: result.code });
        case 'already_owned':    return res.status(409).json({ error: 'Already owned', code: result.code });
        case 'insufficient_funds': return res.status(402).json({ error: 'Not enough Spark Tokens', code: result.code, sparkTokens: result.sparkTokens });
        default:                 return res.status(400).json({ error: 'Purchase failed', code: result.code });
      }
    } catch (err) {
      console.error('[purchase] failed:', err.message);
      return res.status(500).json({ error: 'Purchase failed' });
    }
  });

  return router;
}

module.exports = { makeRouter };
