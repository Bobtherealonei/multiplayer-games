// social/comments.js — the thread under a post: comments, one level of
// replies, comment likes, and the "Challenge sent" cards.
//
//   comments/{id}
//     id, postId, parentId (null for a top-level comment), depth (0 | 1),
//     authorId, text, createdAt (ms), likeCount, replyCount,
//     kind 'comment' | 'challenge' (+ challengeId for a challenge card)
//   commentLikes/{commentId}_{uid}   { commentId, postId, userId, createdAt }
//
// A reply to a reply is attached to the same top-level comment, so there is
// only ever one level of nesting. A post's commentCount counts comments and
// replies, not challenge cards.
//
// While a thread is open the socket sits in the room `post:{postId}` and
// gets `threadEvent` for every change.
//
// Socket events:
//   threadOpen     { postId }                  → { post, items, next } and joins the room
//   threadClose    { postId }
//   comments       { postId, cursor }          → { items, next }
//   commentCreate  { postId, parentId?, text } → { comment }
//   commentDelete  { commentId }
//   commentLike    { commentId, on }           → { liked, likeCount }
//   profileReplies { userId, cursor? }         → { items, next }
//   threadEvent    (server → room) { postId, type, … }
//     type 'comment' { comment } | 'commentRemoved' { commentId, parentId }
//        | 'commentLike' { commentId, likeCount } | 'challenge' { challenge }

const core = require('./core');
const posts = require('./posts');
const notifications = require('./notifications');

const COMMENTS = 'comments';
const LIKES = 'commentLikes';
const IN_CHUNK = 30;
const REPLIES_PER_CHUNK = 300;

const col = () => core.requireDb().collection(COMMENTS);
const ref = (id) => col().doc(id);
const likeRef = (commentId, uid) => core.requireDb().collection(LIKES).doc(`${commentId}_${uid}`);
const byId = () => core.FieldPath().documentId();
const threadRoom = (postId) => `post:${postId}`;

// ── Reading ────────────────────────────────────────────────────────────────

/** Stored comments → what the app draws for `viewerId` (blocked authors dropped). */
async function hydrate(docs, viewerId) {
  if (!docs.length) return [];
  const db = core.requireDb();
  const blocked = await core.blockedBy(viewerId);
  const visible = docs.filter((d) => d.kind === 'challenge' || !blocked.has(d.authorId));
  if (!visible.length) return [];

  const cardIds = visible.filter((d) => d.kind === 'challenge' && d.challengeId).map((d) => d.challengeId);
  const [users, likeSnaps, cards] = await Promise.all([
    core.getUsers(visible.map((d) => d.authorId)),
    db.getAll(...visible.map((d) => likeRef(d.id, viewerId))),
    cardIds.length ? require('./challenges').wireMany(cardIds, viewerId) : new Map()
  ]);
  // A comment whose author has no profile: the account was probably deleted.
  visible.forEach((d) => {
    if (d.kind !== 'challenge' && users.get(d.authorId).missing) require('./purge').consider(d.authorId);
  });

  return visible
    .map((d, i) => ({
      id: d.id,
      postId: d.postId,
      parentId: d.parentId || null,
      kind: d.kind || 'comment',
      author: users.get(d.authorId),
      text: d.text || '',
      createdAt: d.createdAt || core.idTime(d.id),
      likeCount: core.count(d.likeCount),
      liked: likeSnaps[i].exists,
      replyCount: core.count(d.replyCount),
      challenge: d.kind === 'challenge' ? cards.get(d.challengeId) || null : null
    }))
    .filter((c) => c.kind !== 'challenge' || c.challenge);
}

// One page of top-level comments (oldest first), each with its replies.
async function page(postId, cursor, viewerId, size) {
  let query = col().where('postId', '==', postId).where('depth', '==', 0).orderBy(byId(), 'asc');
  if (cursor) query = query.startAfter(cursor);
  const snap = await query.limit(size).get();
  const tops = snap.docs.map((d) => d.data() || {});

  const parents = tops.filter((c) => core.count(c.replyCount) > 0).map((c) => c.id);
  const replyDocs = [];
  for (let i = 0; i < parents.length; i += IN_CHUNK) {
    const chunk = parents.slice(i, i + IN_CHUNK);
    const rs = await col().where('parentId', 'in', chunk).orderBy(byId(), 'asc').limit(REPLIES_PER_CHUNK).get();
    rs.docs.forEach((d) => replyDocs.push(d.data() || {}));
  }

  const wired = await hydrate(tops.concat(replyDocs), viewerId);
  const items = wired.filter((c) => !c.parentId).map((c) => ({ ...c, replies: [] }));
  const index = new Map(items.map((c) => [c.id, c]));
  wired.forEach((c) => {
    if (c.parentId && index.has(c.parentId)) index.get(c.parentId).replies.push(c);
  });
  return { items, next: tops.length === size ? tops[tops.length - 1].id : null };
}

// ── Removing ───────────────────────────────────────────────────────────────

/** Deletes a comment (and, for a top-level one, its replies) and fixes the counts. */
async function removeComment(io, comment) {
  const db = core.requireDb();
  // Deleting a comment takes its replies with it.
  const replySnap = comment.depth === 0 ? await col().where('parentId', '==', comment.id).select().get() : { docs: [] };
  const removed = 1 + replySnap.docs.length;
  const refs = [ref(comment.id), ...replySnap.docs.map((d) => d.ref)];
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
  if (comment.parentId) {
    await db.runTransaction(async (tx) => {
      const parentSnap = await tx.get(ref(comment.parentId));
      if (parentSnap.exists) {
        tx.update(ref(comment.parentId), { replyCount: Math.max(0, core.count(parentSnap.get('replyCount')) - 1) });
      }
    });
  }
  await posts.bump(io, comment.postId, 'commentCount', -removed);
  if (io) {
    io.to(threadRoom(comment.postId)).emit('threadEvent', {
      postId: comment.postId,
      type: 'commentRemoved',
      commentId: comment.id,
      parentId: comment.parentId || null,
      removed
    });
  }
}

/** Takes one person's like off a comment (their account is gone). */
async function dropLike(io, marker) {
  const db = core.requireDb();
  const likeCount = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(marker.commentId));
    tx.delete(likeRef(marker.commentId, marker.userId));
    if (!snap.exists) return null;
    const next = Math.max(0, core.count(snap.get('likeCount')) - 1);
    tx.update(ref(marker.commentId), { likeCount: next });
    return next;
  });
  if (io && likeCount !== null && marker.postId) {
    io.to(threadRoom(marker.postId)).emit('threadEvent', {
      postId: marker.postId,
      type: 'commentLike',
      commentId: marker.commentId,
      likeCount
    });
  }
}

// ── Challenge cards ────────────────────────────────────────────────────────

/** Adds the "Challenge sent" card to a post's thread and shows it to everyone there. */
async function addChallengeCard(io, { postId, challengeId, fromId }) {
  const now = Date.now();
  const card = {
    id: core.newId(now),
    postId,
    parentId: null,
    depth: 0,
    authorId: fromId,
    text: '',
    createdAt: now,
    likeCount: 0,
    replyCount: 0,
    kind: 'challenge',
    challengeId
  };
  await ref(card.id).create(card);
  if (io) {
    const [wire] = await hydrate([card], fromId);
    if (wire) {
      // `reminding` is per viewer; everyone else starts without one.
      io.to(threadRoom(postId)).emit('threadEvent', {
        postId,
        type: 'comment',
        comment: { ...wire, liked: false, replies: [], challenge: { ...wire.challenge, reminding: false } }
      });
    }
  }
  return card.id;
}

/** Tells an open thread that a challenge on it changed (accepted, declined, expired). */
function pushChallenge(io, postId, challenge) {
  if (io && postId) io.to(threadRoom(postId)).emit('threadEvent', { postId, type: 'challenge', challenge });
}

// ── Socket events ──────────────────────────────────────────────────────────

function register({ io, socket, on, userId }) {
  on('threadOpen', async (payload) => {
    const postId = core.requireId(payload.postId);
    const cfg = (await core.loadSocialConfig()).content;
    const [post, comments] = await Promise.all([
      posts.hydrateOne(postId, userId),
      page(postId, null, userId, cfg.commentsPageSize)
    ]);
    await socket.join(threadRoom(postId));
    return { post, ...comments };
  });

  on('threadClose', async (payload) => {
    if (core.optionalId(payload.postId)) await socket.leave(threadRoom(payload.postId));
    return {};
  });

  on('comments', async (payload) => {
    const cfg = (await core.loadSocialConfig()).content;
    return page(core.requireId(payload.postId), core.optionalId(payload.cursor), userId, cfg.commentsPageSize);
  });

  on('commentCreate', async (payload) => {
    const cfg = (await core.loadSocialConfig()).content;
    const postId = core.requireId(payload.postId);
    const text = await core.validText(payload.text, { max: cfg.maxCommentLength });

    const post = await posts.getPost(postId);
    if (!post) throw core.clientError('not_found');
    if (post.authorId !== userId && (await core.blockedBy(post.authorId)).has(userId)) {
      throw core.clientError('not_allowed');
    }

    let parent = null;
    let replyTo = null;
    if (payload.parentId) {
      const snap = await ref(core.requireId(payload.parentId)).get();
      replyTo = snap.exists ? snap.data() : null;
      if (!replyTo || replyTo.postId !== postId || replyTo.kind === 'challenge') throw core.clientError('not_found');
      if (replyTo.authorId !== userId && (await core.blockedBy(replyTo.authorId)).has(userId)) {
        throw core.clientError('not_allowed');
      }
      // One level of nesting: a reply to a reply joins the same parent.
      parent = replyTo.depth === 0 ? replyTo.id : replyTo.parentId;
    }

    const wait = await core.cooldown('comment', userId, cfg.commentCooldownSeconds * 1000);
    if (wait > 0) throw core.clientError('rate_limited', { retryInMs: wait });

    const now = Date.now();
    const comment = {
      id: core.newId(now),
      postId,
      parentId: parent,
      depth: parent ? 1 : 0,
      authorId: userId,
      text,
      createdAt: now,
      likeCount: 0,
      replyCount: 0,
      kind: 'comment'
    };

    const db = core.requireDb();
    await db.runTransaction(async (tx) => {
      const refs = [posts.postRef(postId)];
      if (parent) refs.push(ref(parent));
      const [postSnap, parentSnap] = await tx.getAll(...refs);
      if (!postSnap.exists) throw core.clientError('not_found');
      if (parent && !parentSnap.exists) throw core.clientError('not_found');
      tx.create(ref(comment.id), comment);
      tx.update(posts.postRef(postId), { commentCount: core.count(postSnap.get('commentCount')) + 1 });
      if (parent) tx.update(ref(parent), { replyCount: core.count(parentSnap.get('replyCount')) + 1 });
    });

    const [wire] = await hydrate([comment], userId);
    const out = { ...wire, replies: [] };
    socket.to(threadRoom(postId)).emit('threadEvent', { postId, type: 'comment', comment: out });
    posts.pushCounts(io, postId);

    const quote = core.clip(text, 140);
    if (replyTo) {
      notifications.notify(io, replyTo.authorId, { type: 'reply', actorId: userId, postId, commentId: comment.id, text: quote });
    }
    if (!replyTo || replyTo.authorId !== post.authorId) {
      notifications.notify(io, post.authorId, { type: 'comment', actorId: userId, postId, commentId: comment.id, text: quote });
    }
    return { comment: out };
  });

  on('commentDelete', async (payload) => {
    const commentId = core.requireId(payload.commentId);
    const snap = await ref(commentId).get();
    const comment = snap.exists ? snap.data() : null;
    if (!comment || comment.kind === 'challenge') throw core.clientError('not_found');
    const account = await core.loadAccount(socket, userId);
    if (comment.authorId !== userId && !account.isAdmin) throw core.clientError('not_allowed');
    await removeComment(io, comment);
    return {};
  });

  on('commentLike', async (payload) => {
    const commentId = core.requireId(payload.commentId);
    const turnOn = payload.on !== false;
    await core.rateLimit('like', userId, 120, 60 * 1000);

    const db = core.requireDb();
    const marker = likeRef(commentId, userId);
    const result = await db.runTransaction(async (tx) => {
      const [snap, markerSnap] = await tx.getAll(ref(commentId), marker);
      const comment = snap.exists ? snap.data() : null;
      if (!comment || comment.kind === 'challenge') throw core.clientError('not_found');
      const current = core.count(comment.likeCount);
      if (turnOn === markerSnap.exists) return { changed: false, likeCount: current, comment };
      const next = Math.max(0, current + (turnOn ? 1 : -1));
      if (turnOn) tx.create(marker, { commentId, postId: comment.postId, userId, createdAt: Date.now() });
      else tx.delete(marker);
      tx.update(ref(commentId), { likeCount: next });
      return { changed: true, likeCount: next, comment };
    });

    if (result.changed) {
      const { comment } = result;
      io.to(threadRoom(comment.postId)).emit('threadEvent', {
        postId: comment.postId,
        type: 'commentLike',
        commentId,
        likeCount: result.likeCount
      });
      const key = `c_${commentId}_${userId}`;
      if (turnOn) {
        notifications.notify(io, comment.authorId, {
          type: 'like',
          actorId: userId,
          key,
          postId: comment.postId,
          commentId,
          text: core.clip(comment.text, 140)
        });
      } else {
        notifications.retract(io, comment.authorId, 'like', key);
      }
    }
    return { liked: turnOn, likeCount: result.likeCount };
  });

  on('profileReplies', async (payload) => {
    const cfg = (await core.loadSocialConfig()).content;
    const authorId = core.requireUid(payload.userId);
    if ((await core.blockedBy(userId)).has(authorId)) return { items: [], next: null };

    let query = col().where('authorId', '==', authorId).orderBy(byId(), 'desc');
    const cursor = core.optionalId(payload.cursor);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.limit(cfg.feedPageSize).get();
    const docs = snap.docs.map((d) => d.data() || {});
    const comments = docs.filter((d) => d.kind !== 'challenge');

    const db = core.requireDb();
    const postIds = [...new Set(comments.map((c) => c.postId))];
    const postSnaps = postIds.length ? await db.getAll(...postIds.map((id) => posts.postRef(id))) : [];
    const postDocs = new Map(postSnaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
    const authors = await core.getUsers([...postDocs.values()].map((p) => p.authorId));

    const wired = await hydrate(comments.filter((c) => postDocs.has(c.postId)), userId);
    return {
      items: wired.map((c) => {
        const post = postDocs.get(c.postId);
        return { comment: c, post: { id: post.id, text: core.clip(post.text, 160), author: authors.get(post.authorId) } };
      }),
      next: docs.length === cfg.feedPageSize ? docs[docs.length - 1].id : null
    };
  });
}

module.exports = { register, addChallengeCard, pushChallenge, threadRoom, ref, removeComment, dropLike };
