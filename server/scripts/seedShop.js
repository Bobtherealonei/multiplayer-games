// seedShop.js — one-off script to (re)write the cosmetic catalog into
// Firestore `shopItems` and regenerate the daily/weekly rotations.
//
// Usage (from game-server/server):
//   FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccount.json node scripts/seedShop.js
// or with the JSON inline:
//   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node scripts/seedShop.js
//
// The server also seeds + generates automatically on boot (see
// shopRotation.scheduleRotations), so running this is optional — handy when
// you change the catalog and want it live immediately.

const { getDb } = require('../firestoreClient');
const { CATALOG } = require('../shopCatalog');
const { ensureSeeded, generateDaily, generateWeekly } = require('../shopRotation');

async function main() {
  const db = getDb();
  if (!db) {
    console.error('[seedShop] Firestore unavailable. Set FIREBASE_SERVICE_ACCOUNT_JSON or _PATH.');
    process.exit(1);
  }

  console.log(`[seedShop] writing ${CATALOG.length} items to shopItems...`);
  const batch = db.batch();
  for (const item of CATALOG) {
    batch.set(db.collection('shopItems').doc(item.id), item, { merge: true });
  }
  await batch.commit();

  // ensureSeeded is a no-op now (items exist) but keeps parity with boot path.
  await ensureSeeded(db);
  await generateDaily(db, true);
  await generateWeekly(db, true);

  console.log('[seedShop] done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seedShop] failed:', err);
  process.exit(1);
});
