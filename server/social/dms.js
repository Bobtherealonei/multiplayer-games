// social/dms.js — sending direct messages.
//
// Conversations keep the shape the app has always used, so existing chats
// carry over and older app versions still read them:
//   chats/{uidA_uidB}                 participants, lastMessage, lastUpdated,
//                                     lastSenderId, isActive, deletedFor,
//                                     unread { uid: count }
//   chats/{chatId}/messages/{id}      senderId, toId, fromName, text,
//                                     timestamp, isRead, status, clientId
//
// The app reads its conversations and messages straight from Firestore
// (live listeners). Sending and marking read go through here, which is
// where the checks live: both people exist, neither has blocked the other,
// the text passes the filter, and the sender isn't flooding.
//
// Socket events:
//   dmOpen  { userId }                  → { chatId, user, blocked }
//   dmSend  { toId, text, clientId? }   → { chatId, messageId }
//   dmRead  { chatId }

const core = require('./core');
const notifications = require('./notifications');

const PREVIEW_LENGTH = 200;
const READ_BATCH = 400;

const chats = () => core.requireDb().collection('chats');
const pairId = (a, b) => [a, b].sort().join('_');

// The conversation doc for two people. Chats started from an old debate
// screen used a `debate_` prefix; keep using that doc if it is the one that
// exists so its history stays in one place.
async function findChat(a, b) {
  const db = core.requireDb();
  const plain = chats().doc(pairId(a, b));
  const legacy = chats().doc(`debate_${pairId(a, b)}`);
  const [plainSnap, legacySnap] = await db.getAll(plain, legacy);
  if (plainSnap.exists || !legacySnap.exists) return { ref: plain, snap: plainSnap };
  return { ref: legacy, snap: legacySnap };
}

async function assertParticipant(chatId, userId) {
  if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,300}$/.test(chatId)) throw core.clientError('bad_request');
  const snap = await chats().doc(chatId).get();
  const participants = snap.exists ? snap.get('participants') : null;
  if (!Array.isArray(participants) || !participants.includes(userId)) throw core.clientError('not_allowed');
  return snap;
}

function register({ io, on, userId }) {
  on('dmOpen', async (payload) => {
    const otherId = core.requireUid(payload.userId);
    if (otherId === userId) throw core.clientError('bad_request');
    const [user, chat, block] = await Promise.all([
      core.getUser(otherId),
      findChat(userId, otherId),
      core.blockBetween(userId, otherId)
    ]);
    if (!user || user.missing) throw core.clientError('not_found');
    return { chatId: chat.ref.id, user, blocked: block };
  });

  on('dmSend', async (payload) => {
    const cfg = (await core.loadSocialConfig()).content;
    const toId = core.requireUid(payload.toId);
    if (toId === userId) throw core.clientError('bad_request');
    const text = await core.validText(payload.text, { max: cfg.maxMessageLength, filter: 'slurs' });
    const clientId =
      typeof payload.clientId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(payload.clientId) ? payload.clientId : null;

    const [users] = await Promise.all([core.getUsers([userId, toId]), core.assertNoBlock(userId, toId)]);
    const me = users.get(userId);
    const them = users.get(toId);
    if (!them || them.missing) throw core.clientError('not_found');

    const wait = await core.cooldown('dm', userId, cfg.messageCooldownSeconds * 1000);
    if (wait > 0) throw core.clientError('rate_limited', { retryInMs: wait });

    const FieldValue = core.FieldValue();
    const { ref: chatRef, snap: chatSnap } = await findChat(userId, toId);
    const messageRef = chatRef.collection('messages').doc();
    const batch = core.requireDb().batch();
    batch.set(messageRef, {
      senderId: userId,
      toId,
      fromName: me ? me.name : 'Someone',
      text,
      timestamp: FieldValue.serverTimestamp(),
      isRead: false,
      status: 'visible',
      clientId
    });
    const meta = {
      lastMessage: core.clip(text, PREVIEW_LENGTH),
      lastUpdated: FieldValue.serverTimestamp(),
      lastSenderId: userId,
      isActive: true,
      deletedFor: FieldValue.arrayRemove(userId, toId),
      unread: { [toId]: FieldValue.increment(1) }
    };
    if (!chatSnap.exists) {
      meta.participants = [userId, toId];
      meta.createdAt = FieldValue.serverTimestamp();
    } else if (chatSnap.get('requestStatus') === 'pending' || chatSnap.get('requestStatus') === 'declined') {
      // Chat requests are gone: a conversation is simply open.
      meta.requestStatus = 'accepted';
    }
    batch.set(chatRef, meta, { merge: true });
    await batch.commit();

    notifications.notify(io, toId, {
      type: 'message',
      actorId: userId,
      key: chatRef.id,
      chatId: chatRef.id,
      text: core.clip(text, PREVIEW_LENGTH)
    });
    return { chatId: chatRef.id, messageId: messageRef.id };
  });

  on('dmRead', async (payload) => {
    const snap = await assertParticipant(payload.chatId, userId);
    const db = core.requireDb();
    const unread = await snap.ref
      .collection('messages')
      .where('toId', '==', userId)
      .where('isRead', '==', false)
      .limit(READ_BATCH)
      .select()
      .get();
    const batch = db.batch();
    unread.docs.forEach((d) => batch.update(d.ref, { isRead: true }));
    batch.set(snap.ref, { unread: { [userId]: 0 } }, { merge: true });
    await batch.commit();
    // The matching "new message" notification is now read too.
    await notifications.markKeyRead(io, userId, 'message', snap.id);
    return {};
  });
}

module.exports = { register, pairId };
