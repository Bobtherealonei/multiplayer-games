// social/follows.js — follow / unfollow and the follower lists.
//
// Same edge documents the app has always used, now written by the server:
//   publicProfiles/{uid}/followers/{followerUid}  { uid, createdAt }
//   publicProfiles/{uid}/following/{targetUid}    { uid, createdAt }
// A follow writes both edges in one batch; counts are aggregate count()
// queries over them, so there is no counter to drift.
//
// Socket events:
//   follow      { userId, on }                    → { isFollowing, followers, myFollowing }
//   followList  { userId, kind, cursor? }         → { users, next }

const core = require('./core');
const notifications = require('./notifications');
const { profileRef, followedAmong, followCounts } = require('./profiles');

const PAGE_SIZE = 30;
const FOLLOWING_CACHE_S = 5 * 60;
const FOLLOWING_MAX = 3000;

const followingKey = (uid) => `social:following:${uid}`;

/** Everyone `uid` follows (for the Following feed). Cached in Redis. */
async function followingIds(uid) {
  const cached = await core.redis.get(followingKey(uid));
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (_) {
      // fall through and rebuild
    }
  }
  const snap = await profileRef(core.requireDb(), uid).collection('following').select().limit(FOLLOWING_MAX).get();
  const ids = snap.docs.map((d) => d.id);
  await core.redis.set(followingKey(uid), JSON.stringify(ids), 'EX', FOLLOWING_CACHE_S);
  return ids;
}

async function setFollow(actorId, targetId, on) {
  const db = core.requireDb();
  const followerRef = profileRef(db, targetId).collection('followers').doc(actorId);
  const followingRef = profileRef(db, actorId).collection('following').doc(targetId);
  const batch = db.batch();
  if (on) {
    const createdAt = core.FieldValue().serverTimestamp();
    batch.set(followerRef, { uid: actorId, createdAt });
    batch.set(followingRef, { uid: targetId, createdAt });
  } else {
    batch.delete(followerRef);
    batch.delete(followingRef);
  }
  await batch.commit();
  await core.redis.del(followingKey(actorId));
}

// Blocking someone ends the follow in both directions.
async function severFollows(a, b) {
  await Promise.all([setFollow(a, b, false), setFollow(b, a, false)]);
}

function register({ io, on, userId }) {
  on('follow', async (payload) => {
    const targetId = core.requireUid(payload.userId);
    const turnOn = payload.on !== false;
    if (targetId === userId) throw core.clientError('bad_request');
    await core.rateLimit('follow', userId, 60, 60 * 1000);

    const db = core.requireDb();
    if (turnOn) {
      await core.assertNoBlock(userId, targetId);
      const target = await profileRef(db, targetId).get();
      if (!target.exists) throw core.clientError('not_found');
    }
    const already = (await profileRef(db, targetId).collection('followers').doc(userId).get()).exists;
    if (already !== turnOn) {
      await setFollow(userId, targetId, turnOn);
      if (turnOn) {
        notifications.notify(io, targetId, { type: 'follow', actorId: userId, key: userId });
      } else {
        notifications.retract(io, targetId, 'follow', userId);
      }
    }

    const [theirs, mine] = await Promise.all([followCounts(db, targetId), followCounts(db, userId)]);
    return { isFollowing: turnOn, followers: theirs.followers, myFollowing: mine.following };
  });

  on('followList', async (payload) => {
    const targetId = core.requireUid(payload.userId);
    const kind = payload.kind === 'following' ? 'following' : 'followers';
    const db = core.requireDb();
    const col = profileRef(db, targetId).collection(kind);

    let query = col.orderBy('createdAt', 'desc');
    if (typeof payload.cursor === 'string' && core.UID_RE.test(payload.cursor)) {
      const cursorSnap = await col.doc(payload.cursor).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }
    const snap = await query.limit(PAGE_SIZE).get();
    const uids = snap.docs.map((d) => d.id);

    const [users, followed, blocked] = await Promise.all([
      core.getUsers(uids),
      followedAmong(userId, uids),
      core.blockedBy(userId)
    ]);
    return {
      users: uids
        .filter((uid) => !blocked.has(uid))
        .map((uid) => users.get(uid))
        .filter((u) => u && !u.missing)
        .map((u) => ({ ...u, isFollowing: followed.has(u.id), isMe: u.id === userId })),
      next: uids.length === PAGE_SIZE ? uids[uids.length - 1] : null
    };
  });
}

module.exports = { register, followingIds, severFollows };
