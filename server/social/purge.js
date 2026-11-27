// social/purge.js — removes what a deleted account left behind.
//
// Deleting an account is done by a Cloud Function (confirmAccountDeletion):
// it checks the emailed code, then deletes the sign-in, users/{uid},
// publicProfiles/{uid}, the handle and the follow graph. This module removes
// the rest of what that person made:
//
//   • their posts (with the comments, likes and reposts on them)
//   • their comments and replies
//   • their likes, reposts and comment likes (the counts go down)
//   • their pending challenges, in either direction (withdrawn)
//   • their live-debate messages and side picks
//
// What stays, shown as "Deleted user": their turns in one-on-one debates
// (the debate is also the other person's record), their audience messages
// and votes there, and direct messages they sent (the other person's inbox).
//
// It only ever runs for an account that is verifiably gone: no sign-in, no
// users/{uid}, no publicProfiles/{uid}. Two ways in:
//
//   • `accountPurge` — the app sends it on its still-open socket the moment
//     the Cloud Function reports the account deleted;
//   • `consider(uid)` — called when a post or comment turns up whose author
//     has no profile, which catches accounts deleted any other way (the
//     admin site, the Firebase console, an app that was closed too early).
//
// Socket event:
//   accountPurge   (no payload)

const core = require('./core');
const posts = require('./posts');
const comments = require('./comments');

const BATCH = 200;
const MAX_PASSES = 200;
const RECHECK_SECONDS = 6 * 60 * 60;

let sharedIo = null;

/** True only when there is no sign-in and no profile left for `uid`. */
async function isGone(uid) {
  const db = core.requireDb();
  const [user, profile] = await db.getAll(db.collection('users').doc(uid), db.collection('publicProfiles').doc(uid));
  if (user.exists || profile.exists) return false;
  const auth = core.getAuth();
  if (!auth) return false;
  try {
    await auth.getUser(uid);
    return false;
  } catch (err) {
    return !!err && err.code === 'auth/user-not-found';
  }
}

// Runs `each` over everything a query matches, a batch at a time. `each`
// must delete (or otherwise stop matching) the document it is given.
async function drain(makeQuery, each) {
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const snap = await makeQuery().limit(BATCH).get();
    if (!snap.size) return;
    for (const doc of snap.docs) {
      try {
        await each(doc);
      } catch (err) {
        console.warn('[purge] step failed:', err.message);
        // Never loop forever on a document that can't be processed.
        await doc.ref.delete().catch(() => {});
      }
    }
    if (snap.size < BATCH) return;
  }
}

async function purge(io, uid) {
  const db = core.requireDb();
  const mine = (name, field) => () => db.collection(name).where(field, '==', uid);

  // Posts, and reposts (a repost is an entry in `posts` plus a marker).
  await drain(mine('posts', 'authorId'), async (doc) => {
    const entry = doc.data() || {};
    if (entry.kind === 'repost' && entry.repostOf) {
      const batch = db.batch();
      batch.delete(doc.ref);
      batch.delete(db.collection('postReposts').doc(`${entry.repostOf}_${uid}`));
      await batch.commit();
      await posts.bump(io, entry.repostOf, 'repostCount', -1);
    } else {
      await posts.removePost(io, doc.id);
    }
  });
  // Repost markers whose entry was already gone.
  await drain(mine('postReposts', 'userId'), async (doc) => {
    const marker = doc.data() || {};
    await doc.ref.delete();
    if (marker.entryId) await posts.postRef(marker.entryId).delete().catch(() => {});
    if (marker.postId) await posts.bump(io, marker.postId, 'repostCount', -1);
  });
  await drain(mine('postLikes', 'userId'), async (doc) => {
    const marker = doc.data() || {};
    await doc.ref.delete();
    if (marker.postId) await posts.bump(io, marker.postId, 'likeCount', -1);
  });

  // Comments and replies. A top-level comment takes its replies with it, so
  // one of theirs may already be gone by the time it comes up.
  await drain(mine('comments', 'authorId'), async (doc) => {
    const fresh = await doc.ref.get();
    if (!fresh.exists) return;
    const comment = fresh.data() || {};
    if (comment.kind === 'challenge' || !comment.postId) await doc.ref.delete();
    else await comments.removeComment(io, { ...comment, id: doc.id });
  });
  await drain(mine('commentLikes', 'userId'), async (doc) => {
    const marker = doc.data() || {};
    if (marker.commentId) await comments.dropLike(io, { ...marker, userId: uid });
    else await doc.ref.delete();
  });

  await require('./challenges').withdrawAll(io, uid);
  await require('./live').removeUser(io, uid);

  core.forgetUser(uid);
  core.forgetBlocks(uid);
}

/**
 * Content turned up whose author has no profile. If the account really is
 * gone, clean up after it. Checked at most once every few hours per person.
 */
function consider(uid) {
  if (!uid) return;
  (async () => {
    const first = await core.redis.set(`purge:checked:${uid}`, '1', 'EX', RECHECK_SECONDS, 'NX');
    if (!first) return;
    if (await isGone(uid)) {
      await purge(sharedIo, uid);
      console.log(`[purge] removed what deleted account ${uid} left behind`);
    }
  })().catch((err) => console.warn('[purge] check failed:', err.message));
}

function register({ io, on, userId }) {
  on(
    'accountPurge',
    async () => {
      await core.rateLimit('purge', userId, 5, 60 * 60 * 1000);
      if (!(await isGone(userId))) throw core.clientError('not_allowed');
      // Can take a while for a busy account; the app doesn't wait for it.
      purge(io, userId)
        .then(() => console.log(`[purge] removed what deleted account ${userId} left behind`))
        .catch((err) => console.error('[purge] failed:', err.message));
      return {};
    },
    { open: true }
  );
}

function start(io) {
  sharedIo = io;
}

function stop() {
  sharedIo = null;
}

module.exports = { register, start, stop, purge, consider, isGone };
