// social/notifications.js — the in-app notification list, its unread badge,
// and the matching push notification.
//
//   users/{uid}/notifications/{id}
//     id, type, actorId, read, createdAt (ms), sortKey,
//     postId?, commentId?, challengeId?, debateId?, chatId?, topicId?,
//     messageId?, text?
//
// Types: follow, like, comment, reply, challenge, challenge_accepted,
// challenge_declined, debate_turn, debate_started, debate_result, message.
//
// Events that would otherwise pile up (the same person liking and unliking,
// several messages in one conversation, each turn of one debate) pass a
// `key`: the notification for that key is rewritten and bumped to the top
// instead of a new one being added.
//
// Socket events:
//   notifications     { cursor? }        → { items, next, unread }
//   notificationsRead { ids? | all }     → { unread }
//   notification      (server → user)    → { item, unread }

const core = require('./core');

const PAGE_SIZE = 30;
const UNREAD_CAP = 99;
const MARK_ALL_LIMIT = 400;
const TYPES = new Set([
  'follow',
  'like',
  'comment',
  'reply',
  'challenge',
  'challenge_accepted',
  'challenge_declined',
  'debate_turn',
  'debate_started',
  'debate_result',
  'message'
]);

const listRef = (uid) => core.requireDb().collection('users').doc(uid).collection('notifications');

async function unreadCount(uid) {
  const snap = await listRef(uid).where('read', '==', false).count().get();
  return Math.min(snap.data().count, UNREAD_CAP);
}

// Title and body of the push for one notification.
function pushText(n, actor) {
  const who = actor && !actor.missing ? actor.name : 'Someone';
  const quote = n.text ? `: ${core.clip(n.text, 120)}` : '';
  switch (n.type) {
    case 'follow':
      return { title: 'New follower', body: `${who} followed you` };
    case 'like':
      return { title: 'Trendspark', body: `${who} liked your ${n.commentId ? 'comment' : 'post'}` };
    case 'comment':
      return { title: 'New comment', body: `${who} commented${quote}` };
    case 'reply':
      return { title: 'New reply', body: `${who} replied${quote}` };
    case 'challenge':
      return { title: '1-on-1 challenge', body: `${who} challenged you to a one-on-one debate` };
    case 'challenge_accepted':
      return { title: 'Challenge accepted', body: `${who} accepted. Your debate is live.` };
    case 'challenge_declined':
      return { title: 'Challenge declined', body: `${who} declined your challenge` };
    case 'debate_turn':
      return { title: 'Your turn', body: `It's your turn against ${who}` };
    case 'debate_started':
      return { title: 'Debate starting', body: n.text || 'A debate you asked about is live now' };
    case 'debate_result':
      return { title: 'Debate finished', body: n.text || `Your debate with ${who} has ended` };
    case 'message':
      return { title: who, body: core.clip(n.text || 'Sent you a message', 200) };
    default:
      return { title: 'Trendspark', body: '' };
  }
}

/**
 * Push notification to the user's device, if they have one registered.
 * Never throws: a missing or stale token just means no push.
 */
async function sendPush(userId, { title, body, data = {} }) {
  try {
    const db = core.requireDb();
    const snap = await db.collection('users').doc(userId).get();
    const token = snap.exists ? String(snap.get('fcmToken') || '').trim() : '';
    if (!token) return false;
    const stringData = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) stringData[k] = String(v);
    }
    await core.getAdmin().messaging().send({
      token,
      notification: { title: core.clip(title, 120) || 'Trendspark', body: core.clip(body, 240) },
      data: stringData,
      apns: { payload: { aps: { sound: 'default' } } }
    });
    return true;
  } catch (err) {
    console.warn(`[notifications] push to ${userId} failed:`, err.message);
    return false;
  }
}

function wire(data, users) {
  return {
    id: data.id,
    type: data.type,
    actor: data.actorId ? users.get(data.actorId) || null : null,
    read: data.read === true,
    createdAt: data.createdAt || 0,
    postId: data.postId || null,
    commentId: data.commentId || null,
    challengeId: data.challengeId || null,
    debateId: data.debateId || null,
    chatId: data.chatId || null,
    topicId: data.topicId || null,
    messageId: data.messageId || null,
    text: data.text || null
  };
}

/**
 * Adds one notification for `toId`, pushes it to their open sockets and
 * their device. Never throws; a failed notification must not fail the
 * action that caused it.
 *
 * `n`: { type, actorId, key?, postId?, commentId?, challengeId?, debateId?,
 *        chatId?, text?, push? (false to skip the device push) }
 */
async function notify(io, toId, n) {
  try {
    if (!toId || !n || !TYPES.has(n.type) || toId === n.actorId) return null;
    if (n.actorId && (await core.blockedBy(toId)).has(n.actorId)) return null;

    const now = Date.now();
    const id = n.key ? keyedId(n.type, n.key) : core.newId(now);
    const data = {
      id,
      type: n.type,
      actorId: n.actorId || null,
      read: false,
      createdAt: now,
      sortKey: core.newId(now),
      postId: n.postId || null,
      commentId: n.commentId || null,
      challengeId: n.challengeId || null,
      debateId: n.debateId || null,
      chatId: n.chatId || null,
      topicId: n.topicId || null,
      messageId: n.messageId || null,
      text: n.text ? core.clip(n.text, 300) : null
    };
    await listRef(toId).doc(id).set(data);

    const users = n.actorId ? await core.getUsers([n.actorId]) : new Map();
    const item = wire(data, users);
    if (io) {
      const unread = await unreadCount(toId);
      io.to(core.userRoom(toId)).emit('notification', { item, unread });
    }
    if (n.push !== false) {
      const text = pushText(data, item.actor);
      sendPush(toId, {
        ...text,
        data: {
          kind: 'social',
          type: data.type,
          notificationId: id,
          postId: data.postId,
          debateId: data.debateId,
          challengeId: data.challengeId,
          chatId: data.chatId,
          topicId: data.topicId,
          userId: data.actorId
        }
      });
    }
    return item;
  } catch (err) {
    console.error('[notifications] notify failed:', err.message);
    return null;
  }
}

const keyedId = (type, key) => `${type}_${String(key).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200)}`;

// Marks a keyed notification read (the conversation was opened, the debate
// was joined) without the user having to open the list.
async function markKeyRead(io, userId, type, key) {
  try {
    await listRef(userId).doc(keyedId(type, key)).update({ read: true });
    if (io) io.to(core.userRoom(userId)).emit('notificationsUnread', { unread: await unreadCount(userId) });
  } catch (_) {
    // No such notification: nothing to mark.
  }
}

// Takes back a notification written with `key` (an unlike, an unfollow).
async function retract(io, toId, type, key) {
  try {
    const id = keyedId(type, key);
    await listRef(toId).doc(id).delete();
    if (io) io.to(core.userRoom(toId)).emit('notificationRemoved', { id, unread: await unreadCount(toId) });
  } catch (err) {
    console.warn('[notifications] retract failed:', err.message);
  }
}

async function list(userId, cursor) {
  let query = listRef(userId).orderBy('sortKey', 'desc');
  if (cursor) query = query.startAfter(cursor);
  const snap = await query.limit(PAGE_SIZE).get();
  const docs = snap.docs.map((d) => d.data() || {});
  const blocked = await core.blockedBy(userId);
  const visible = docs.filter((d) => !d.actorId || !blocked.has(d.actorId));
  const users = await core.getUsers(visible.map((d) => d.actorId));
  return {
    items: visible.map((d) => wire(d, users)),
    next: docs.length === PAGE_SIZE ? docs[docs.length - 1].sortKey : null
  };
}

async function markRead(userId, { ids, all }) {
  let refs = [];
  if (all) {
    const snap = await listRef(userId).where('read', '==', false).limit(MARK_ALL_LIMIT).select().get();
    refs = snap.docs.map((d) => d.ref);
  } else if (Array.isArray(ids)) {
    refs = ids
      .filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,260}$/.test(id))
      .slice(0, 100)
      .map((id) => listRef(userId).doc(id));
  }
  // One update per doc rather than a batch: update() refuses a doc that was
  // removed in the meantime, and that must not fail the rest.
  await Promise.allSettled(refs.map((ref) => ref.update({ read: true })));
}

function register({ io, on, userId }) {
  on('notifications', async (payload) => {
    const cursor = core.optionalId(payload.cursor);
    const [page, unread] = await Promise.all([list(userId, cursor), unreadCount(userId)]);
    return { ...page, unread };
  });

  on('notificationsRead', async (payload) => {
    await markRead(userId, { ids: payload.ids, all: payload.all === true });
    const unread = await unreadCount(userId);
    io.to(core.userRoom(userId)).emit('notificationsUnread', { unread });
    return { unread };
  });
}

module.exports = { register, notify, retract, markKeyRead, sendPush, unreadCount };
