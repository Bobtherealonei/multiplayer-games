// shopRotation.js — generates and maintains the shared Spark Shop rotations.
//
// Two rotations live in Firestore so every user (and every server instance)
// sees the same shop:
//   shopRotations/daily   — 4 items, refreshes at local midnight
//   shopRotations/weekly  — 3 items, refreshes Monday local midnight
//
// DETERMINISTIC SELECTION
//   The picked items are a deterministic function of the day/week key (a
//   seeded shuffle over the sorted candidate ids). So even if multiple server
//   instances regenerate concurrently, they all produce the SAME set — there
//   is no "different shop on refresh / reinstall". Firestore just persists the
//   agreed-upon set + denormalised item data for cheap client reads.

const cron = require('node-cron');
const { getDb } = require('./firestoreClient');
const { CATALOG } = require('./shopCatalog');
const {
  SHOP_TIMEZONE,
  dayKey,
  weekKey,
  nextDailyResetMs,
  nextWeeklyResetMs
} = require('./timeUtil');

const DAILY_COUNT = 4;
const WEEKLY_COUNT = 3;

// ── Deterministic PRNG (mulberry32) seeded from a string ──────────────────
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededPick(candidates, count, seedKey) {
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const rand = mulberry32(hashString(seedKey));
  // Fisher-Yates with the seeded RNG.
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  return sorted.slice(0, Math.min(count, sorted.length));
}

// ── Seeding the catalog ───────────────────────────────────────────────────
async function ensureSeeded(db) {
  const snap = await db.collection('shopItems').limit(1).get();
  if (snap.empty) {
    console.log('[shop] shopItems empty — seeding catalog');
  }
  await syncCatalog(db);
}

/** Merge the in-memory catalog into Firestore so new items appear after deploy. */
async function syncCatalog(db) {
  const batch = db.batch();
  for (const item of CATALOG) {
    batch.set(db.collection('shopItems').doc(item.id), item, { merge: true });
  }
  await batch.commit();
}

async function loadCatalogFromDb(db) {
  const snap = await db.collection('shopItems').get();
  if (snap.empty) return CATALOG; // fall back to in-memory catalog
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ── Rotation generation ─────────────────────────────────────────────────
async function generateDaily(db, force = false) {
  const ref = db.collection('shopRotations').doc('daily');
  const key = dayKey();
  const existing = await ref.get();
  if (!force && existing.exists && existing.data().dayKey === key) return existing.data();

  const catalog = await loadCatalogFromDb(db);
  const candidates = catalog.filter((i) => i.rotationType === 'daily');
  const items = seededPick(candidates, DAILY_COUNT, `daily:${key}`);
  const payload = {
    rotationType: 'daily',
    dayKey: key,
    items,
    itemIds: items.map((i) => i.id),
    availableUntil: nextDailyResetMs(),
    generatedAt: Date.now()
  };
  await ref.set(payload);
  console.log(`[shop] daily rotation set for ${key}: ${payload.itemIds.join(', ')}`);
  return payload;
}

async function generateWeekly(db, force = false) {
  const ref = db.collection('shopRotations').doc('weekly');
  const key = weekKey();
  const existing = await ref.get();
  if (!force && existing.exists && existing.data().weekKey === key) return existing.data();

  const catalog = await loadCatalogFromDb(db);
  const candidates = catalog.filter((i) => i.rotationType === 'weekly');
  const items = seededPick(candidates, WEEKLY_COUNT, `weekly:${key}`);
  const payload = {
    rotationType: 'weekly',
    weekKey: key,
    items,
    itemIds: items.map((i) => i.id),
    availableUntil: nextWeeklyResetMs(),
    generatedAt: Date.now()
  };
  await ref.set(payload);
  console.log(`[shop] weekly rotation set for ${key}: ${payload.itemIds.join(', ')}`);
  return payload;
}

async function ensureRotations() {
  const db = getDb();
  if (!db) {
    console.warn('[shop] Firestore unavailable — cannot generate rotations');
    return;
  }
  try {
    await ensureSeeded(db);
    await generateDaily(db);
    await generateWeekly(db);
  } catch (err) {
    console.error('[shop] ensureRotations failed:', err.message);
  }
}

function scheduleRotations() {
  // Run once at boot so a fresh deploy has a shop immediately.
  ensureRotations();

  // Daily at local midnight.
  cron.schedule('0 0 * * *', () => {
    const db = getDb();
    if (db) generateDaily(db, true).catch((e) => console.error('[shop] daily cron failed:', e.message));
  }, { timezone: SHOP_TIMEZONE });

  // Weekly Monday at local midnight.
  cron.schedule('0 0 * * 1', () => {
    const db = getDb();
    if (db) generateWeekly(db, true).catch((e) => console.error('[shop] weekly cron failed:', e.message));
  }, { timezone: SHOP_TIMEZONE });

  console.log(`[shop] rotation cron scheduled (timezone ${SHOP_TIMEZONE})`);
}

module.exports = {
  ensureSeeded,
  syncCatalog,
  ensureRotations,
  scheduleRotations,
  generateDaily,
  generateWeekly,
  seededPick
};
