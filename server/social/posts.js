// social/posts.js — posts, the two feeds, likes and reposts.
//
//   posts/{id}
//     kind 'post':   id, authorId, text, createdAt (ms), likeCount,
//                    repostCount, commentCount, debateCount
//     kind 'repost': id, authorId (who reposted), repostOf (post id), createdAt
//   postLikes/{postId}_{uid}     { postId, userId, createdAt }
//   postReposts/{postId}_{uid}   { postId, userId, entryId, createdAt }
//
// A repost is its own entry in `posts`, so it shows up in the reposter's
// followers' Following tab and on the reposter's profile; the like / repost
// marker docs are what make each of those once-per-person.
//
// For you: the newest `forYouWindow` posts ranked by engagement with a
// time decay, then plain newest-first below that. The ranking is frozen for
// a few seconds and shared by everyone, so paging through it never repeats
// or skips a post.
// Following: posts and reposts by the people you follow, newest first.
//
// Socket events:
//   postCreate   { text }                 → { post }
//   postDelete   { postId }
//   feed         { tab, cursor? }         → { items, next }
//   postGet      { postId }               → { post }
//   postLike     { postId, on }           → { liked, likeCount }
//   postRepost   { postId, on }           → { reposted, repostCount }
//   profilePosts { userId, cursor? }      → { items, next }
//   postCounts   (server → everyone)      → { id, likeCount, repostCount, commentCount, debateCount }
//   postRemoved  (server → everyone)      → { id }

const crypto = require('crypto');
const core = require('./core');
const notifications = require('./notifications');
const { followingIds } = require('./follows');

const POSTS = 'posts';
const LIKES = 'postLikes';
const REPOSTS = 'postReposts';

const WINDOW_CACHE_MS = 5 * 1000;
const SNAPSHOT_TTL_S = 20 * 60;
const IN_CHUNK = 30;
const COUNTS_PUSH_MS = 300;
const DELETE_BATCH = 400;

const col = () => core.requireDb().collection(POSTS);
const postRef = (id) => col().doc(id);
const likeRef = (postId, uid) => core.requireDb().collection(LIKES).doc(`${postId}_${uid}`);
const repostRef = (postId, uid) => core.requireDb().collection(REPOSTS).doc(`${postId}_${uid}`);
const byNewest = () => core.FieldPath().documentId();
// Every entry, newest first. Ordered by the `id` field (a copy of the
// document id): Firestore indexes fields in both directions by itself, but
// document ids only ascending.
const newestFirst = () => col().orderBy('id', 'desc');

const countsOf = (p) => ({
  likeCount: core.count(p.likeCount),
  repostCount: core.count(p.repostCount),
  commentCount: core.count(p.commentCount),
  debateCount: core.count(p.debateCount)
});

// ── Reading ────────────────────────────────────────────────────────────────

async function getPost(postId) {
  const snap = await postRef(postId).get();
  const data = snap.exists ? snap.data() : null;
  return data && data.kind === 'post' ? data : null;
}

/**
 * Turns stored entries (posts and reposts) into what the app draws for
 * `viewerId`: author, counts, whether they liked / reposted it. Entries
 * whose post is gone, or whose author the viewer blocked, are dropped.
 */
async function hydrate(entries, viewerId) {
  if (!entries.length) return [];
  const db = core.requireDb();

  const posts = new Map();
  entries.forEach((e) => {
    if (e.kind === 'post') posts.set(e.id, e);
  });
  const missing = [...new Set(entries.filter((e) => e.kind === 'repost' && !posts.has(e.repostOf)).map((e) => e.repostOf))];
  if (missing.length) {
    const snaps = await db.getAll(...missing.map((id) => postRef(id)));
    snaps.forEach((snap) => {
      if (snap.exists && snap.get('kind') === 'post') posts.set(snap.id, snap.data());
    });
  }

  const blocked = await core.blockedBy(viewerId);
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    const post = entry.kind === 'post' ? entry : posts.get(entry.repostOf);
    if (!post) {
      // The original was deleted: drop the dangling repost entry.
      if (entry.kind === 'repost') postRef(entry.id).delete().catch(() => {});
      continue;
    }
    if (blocked.has(post.authorId) || blocked.has(entry.authorId) || seen.has(post.id)) continue;
    seen.add(post.id);
    rows.push({ entry, post });
  }
  if (!rows.length) return [];

  const [users, likeSnaps, repostSnaps] = await Promise.all([
    core.getUsers(rows.flatMap((r) => [r.post.authorId, r.entry.authorId])),
    db.getAll(...rows.map((r) => likeRef(r.post.id, viewerId))),
    db.getAll(...rows.map((r) => repostRef(r.post.id, viewerId)))
  ]);
  // A post whose author has no profile: the account was probably deleted.
  rows.forEach((r) => {
    if (users.get(r.post.authorId).missing) require('./purge').consider(r.post.authorId);
  });

  return rows.map(({ entry, post }, i) => ({
    id: post.id,
    entryId: entry.id,
    author: users.get(post.authorId),
    text: post.text,
    createdAt: post.createdAt || core.idTime(post.id),
    ...countsOf(post),
    liked: likeSnaps[i].exists,
    reposted: repostSnaps[i].exists,
    repostedBy: entry.kind === 'repost' ? users.get(entry.authorId) : null,
    isMine: post.authorId === viewerId
  }));
}

async function hydrateOne(postId, viewerId) {
  const post = await getPost(postId);
  if (!post) throw core.clientError('not_found');
  const [wire] = await hydrate([post], viewerId);
  if (!wire) throw core.clientError('not_found');
  return wire;
}

// ── For you ────────────────────────────────────────────────────────────────

let windowCache = { at: 0, snapId: null, ids: [], oldest: null };

function score(post, now, halfLifeHours) {
  const c = countsOf(post);
  const engagement = c.likeCount + 2 * c.commentCount + 2 * c.repostCount + 3 * c.debateCount;
  const ageHours = Math.max(0, now - (post.createdAt || core.idTime(post.id))) / 3600000;
  return (1 + Math.log1p(engagement)) * Math.pow(0.5, ageHours / halfLifeHours);
}

const snapshotKey = (snapId) => `social:foryou:${snapId}`;

// The current ranking: built at most every few seconds, stored in Redis so
// later pages (served by any instance) read the same order.
async function currentRanking(cfg) {
  const now = Date.now();
  if (windowCache.snapId && now - windowCache.at < WINDOW_CACHE_MS) return windowCache;

  const snap = await newestFirst().limit(cfg.forYouWindow).get();
  const docs = snap.docs.map((d) => d.data() || {});
  const ranked = docs
    .filter((d) => d.kind === 'post')
    .map((d) => ({ id: d.id, s: score(d, now, cfg.forYouHalfLifeHours) }))
    .sort((a, b) => b.s - a.s || (a.id < b.id ? 1 : -1))
    .map((r) => r.id);

  const snapId = crypto.randomBytes(6).toString('hex');
  // Below the ranked window the feed continues newest-first from here.
  const oldest = docs.length === cfg.forYouWindow ? docs[docs.length - 1].id : null;
  await core.redis.set(snapshotKey(snapId), JSON.stringify({ ids: ranked, oldest }), 'EX', SNAPSHOT_TTL_S);
  windowCache = { at: now, snapId, ids: ranked, oldest };
  return windowCache;
}

async function loadRanking(snapId) {
  if (windowCache.snapId === snapId) return windowCache;
  const raw = await core.redis.get(snapshotKey(snapId));
  if (!raw) throw core.clientError('stale_cursor');
  return JSON.parse(raw);
}

// Plain newest-first posts older than `afterId` (reposts skipped).
async function olderPosts(afterId, size, viewerId) {
  const items = [];
  let cursor = afterId;
  let more = true;
  for (let pass = 0; pass < 4 && items.length < size && more; pass++) {
    const snap = await newestFirst().startAfter(cursor).limit(size * 2).get();
    more = snap.size === size * 2;
    if (!snap.size) break;
    const docs = snap.docs.map((d) => d.data() || {});
    let used = docs.length;
    const wired = await hydrate(docs.filter((d) => d.kind === 'post'), viewerId);
    for (const w of wired) {
      if (items.length >= size) {
        used = docs.findIndex((d) => d.id === w.id);
        more = true;
        break;
      }
      items.push(w);
    }
    cursor = docs[Math.max(used - 1, 0)].id;
  }
  return { items, next: more ? `old:${cursor}` : null };
}

async function forYou(viewerId, cursor, cfg) {
  const size = cfg.feedPageSize;
  if (typeof cursor === 'string' && cursor.startsWith('old:')) {
    return olderPosts(core.requireId(cursor.slice(4)), size, viewerId);
  }

  let ranking;
  let offset = 0;
  let snapId;
  if (typeof cursor === 'string' && cursor.startsWith('fy:')) {
    const [, id, rawOffset] = cursor.split(':');
    snapId = id;
    offset = Math.max(0, parseInt(rawOffset, 10) || 0);
    ranking = await loadRanking(snapId);
  } else {
    ranking = await currentRanking(cfg);
    snapId = ranking.snapId;
  }

  const db = core.requireDb();
  const items = [];
  while (items.length < size && offset < ranking.ids.length) {
    const slice = ranking.ids.slice(offset, offset + size);
    const snaps = await db.getAll(...slice.map((id) => postRef(id)));
    const docs = snaps.filter((s) => s.exists).map((s) => s.data());
    const wired = await hydrate(docs, viewerId);
    const room = size - items.length;
    if (wired.length > room) {
      // Stop right after the last post that fits, so the rest come next page.
      const lastTaken = wired[room - 1].id;
      items.push(...wired.slice(0, room));
      offset += slice.indexOf(lastTaken) + 1;
    } else {
      items.push(...wired);
      offset += slice.length;
    }
  }

  if (offset < ranking.ids.length) return { items, next: `fy:${snapId}:${offset}` };
  if (!ranking.oldest) return { items, next: null };
  if (items.length >= size) return { items, next: `old:${ranking.oldest}` };
  const rest = await olderPosts(ranking.oldest, size - items.length, viewerId);
  return { items: items.concat(rest.items), next: rest.next };
}

// ── Following ──────────────────────────────────────────────────────────────

async function byAuthors(authorIds, cursor, size, viewerId) {
  if (!authorIds.length) return { items: [], next: null };
  const chunks = [];
  for (let i = 0; i < authorIds.length; i += IN_CHUNK) chunks.push(authorIds.slice(i, i + IN_CHUNK));
  const snaps = await Promise.all(
    chunks.map((chunk) => {
      let q = col().where('authorId', 'in', chunk).orderBy(byNewest(), 'desc');
      if (cursor) q = q.startAfter(cursor);
      return q.limit(size).get();
    })
  );
  const all = snaps.flatMap((snap) => snap.docs.map((d) => d.data() || {})).sort((a, b) => (a.id < b.id ? 1 : -1));
  const docs = all.slice(0, size);
  const more = all.length > size || snaps.some((snap) => snap.size === size);
  return {
    items: await hydrate(docs, viewerId),
    next: more && docs.length ? docs[docs.length - 1].id : null
  };
}

// ── Counts ─────────────────────────────────────────────────────────────────

const debounceCounts = core.makeDebouncer(COUNTS_PUSH_MS);

// Tells every open app the post's new counts (coalesced per post).
function pushCounts(io, postId) {
  if (!io) return;
  debounceCounts(postId, async () => {
    const post = await getPost(postId);
    if (post) io.to(core.ROOM_ALL).emit('postCounts', { id: postId, ...countsOf(post) });
  });
}

/** Adds `delta` to one of a post's counters (never below zero). */
async function bump(io, postId, field, delta) {
  const db = core.requireDb();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(postRef(postId));
    if (!snap.exists) return;
    tx.update(postRef(postId), { [field]: Math.max(0, core.count(snap.get(field)) + delta) });
  });
  pushCounts(io, postId);
}

// Flips a once-per-person marker (like or repost) and the post's counter in
// one transaction. Returns { changed, count, authorId }.
async function toggleMarker({ postId, markerRef, field, on, markerData, extra }) {
  const db = core.requireDb();
  return db.runTransaction(async (tx) => {
    const [postSnap, markerSnap] = await tx.getAll(postRef(postId), markerRef);
    if (!postSnap.exists || postSnap.get('kind') !== 'post') throw core.clientError('not_found');
    const authorId = postSnap.get('authorId');
    const current = core.count(postSnap.get(field));
    if (on === markerSnap.exists) return { changed: false, count: current, authorId, marker: markerSnap.data() || null };
    const next = Math.max(0, current + (on ? 1 : -1));
    if (on) tx.create(markerRef, markerData);
    else tx.delete(markerRef);
    tx.update(postRef(postId), { [field]: next });
    if (extra) extra(tx, markerSnap.data() || null);
    return { changed: true, count: next, authorId, marker: markerSnap.data() || null };
  });
}

async function assertCanInteract(actorId, authorId) {
  if (actorId !== authorId && (await core.blockedBy(authorId)).has(actorId)) throw core.clientError('not_allowed');
}

/** Deletes a post, tells every open app, and clears what hung off it. */
async function removePost(io, postId) {
  await postRef(postId).delete();
  windowCache.at = 0;
  if (io) io.to(core.ROOM_ALL).emit('postRemoved', { id: postId });
  sweepPost(postId).catch((err) => console.error('[posts] sweep failed:', err.message));
}

// Removes a deleted post's comments and markers in the background.
async function sweepPost(postId) {
  const db = core.requireDb();
  for (const [name, field] of [['comments', 'postId'], ['commentLikes', 'postId'], [LIKES, 'postId'], [REPOSTS, 'postId']]) {
    for (let pass = 0; pass < 50; pass++) {
      const snap = await db.collection(name).where(field, '==', postId).limit(DELETE_BATCH).select().get();
      if (!snap.size) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < DELETE_BATCH) break;
    }
  }
}

// ── Socket events ──────────────────────────────────────────────────────────

function register({ io, socket, on, userId }) {
  on('postCreate', async (payload) => {
    const cfg = (await core.loadSocialConfig()).content;
    const text = await core.validText(payload.text, { max: cfg.maxPostLength });
    const wait = await core.cooldown('post', userId, cfg.postCooldownSeconds * 1000);
    if (wait > 0) throw core.clientError('rate_limited', { retryInMs: wait });

    const now = Date.now();
    const post = {
      id: core.newId(now),
      kind: 'post',
      authorId: userId,
      text,
      createdAt: now,
      likeCount: 0,
      repostCount: 0,
      commentCount: 0,
      debateCount: 0
    };
    await postRef(post.id).create(post);
    windowCache.at = 0; // the next For you request ranks again, with this post
    socket.to(core.ROOM_ALL).emit('postCreated', { id: post.id, authorId: userId });
    const [wire] = await hydrate([post], userId);
    return { post: wire };
  });

  on('postDelete', async (payload) => {
    const postId = core.requireId(payload.postId);
    const post = await getPost(postId);
    if (!post) throw core.clientError('not_found');
    const account = await core.loadAccount(socket, userId);
    if (post.authorId !== userId && !account.isAdmin) throw core.clientError('not_allowed');
    await removePost(io, postId);
    return {};
  });

  on('feed', async (payload) => {
    const cfg = (await core.loadSocialConfig()).content;
    if (payload.tab === 'following') {
      const ids = (await followingIds(userId)).filter((id) => id !== userId);
      const cursor = core.optionalId(payload.cursor);
      return { ...(await byAuthors(ids, cursor, cfg.feedPageSize, userId)), followingCount: ids.length };
    }
    return forYou(userId, payload.cursor, cfg);
  });

  on('postGet', async (payload) => {
    return { post: await hydrateOne(core.requireId(payload.postId), userId) };
  });

  on('profilePosts', async (payload) => {
    const cfg = (await core.loadSocialConfig()).content;
    const authorId = core.requireUid(payload.userId);
    if ((await core.blockedBy(userId)).has(authorId)) return { items: [], next: null };
    return byAuthors([authorId], core.optionalId(payload.cursor), cfg.feedPageSize, userId);
  });

  on('postLike', async (payload) => {
    const postId = core.requireId(payload.postId);
    const turnOn = payload.on !== false;
    await core.rateLimit('like', userId, 120, 60 * 1000);
    const post = await getPost(postId);
    if (!post) throw core.clientError('not_found');
    if (turnOn) await assertCanInteract(userId, post.authorId);

    const result = await toggleMarker({
      postId,
      markerRef: likeRef(postId, userId),
      field: 'likeCount',
      on: turnOn,
      markerData: { postId, userId, createdAt: Date.now() }
    });
    if (result.changed) {
      pushCounts(io, postId);
      const key = `${postId}_${userId}`;
      if (turnOn) {
        notifications.notify(io, result.authorId, {
          type: 'like',
          actorId: userId,
          key,
          postId,
          text: core.clip(post.text, 140)
        });
      } else {
        notifications.retract(io, result.authorId, 'like', key);
      }
    }
    return { liked: turnOn, likeCount: result.count };
  });

  on('postRepost', async (payload) => {
    const postId = core.requireId(payload.postId);
    const turnOn = payload.on !== false;
    await core.rateLimit('repost', userId, 60, 60 * 1000);
    const post = await getPost(postId);
    if (!post) throw core.clientError('not_found');
    if (post.authorId === userId) throw core.clientError('own_post');
    if (turnOn) await assertCanInteract(userId, post.authorId);

    const now = Date.now();
    const entryId = core.newId(now);
    const result = await toggleMarker({
      postId,
      markerRef: repostRef(postId, userId),
      field: 'repostCount',
      on: turnOn,
      markerData: { postId, userId, entryId, createdAt: now },
      extra: (tx, previous) => {
        if (turnOn) {
          tx.create(postRef(entryId), { id: entryId, kind: 'repost', authorId: userId, repostOf: postId, createdAt: now });
        } else if (previous && previous.entryId) {
          tx.delete(postRef(previous.entryId));
        }
      }
    });
    if (result.changed) pushCounts(io, postId);
    return { reposted: turnOn, repostCount: result.count };
  });
}

module.exports = { register, getPost, hydrate, hydrateOne, bump, pushCounts, postRef, removePost };
