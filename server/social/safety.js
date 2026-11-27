// social/safety.js — blocking people and reporting content.
//
//   users/{uid}/blocks/{blockedUid}   { blockedUserId, blockedUserName, source, createdAt }
//   socialReports/{reporter}_{type}_{target}
//     reporterId, targetType, contentType, targetId, targetUserId, text,
//     reason, details, context, status 'open', createdAt
//
// Blocking someone hides their posts, comments and messages from you, ends
// any follow between you, withdraws pending challenges between you, and
// stops them messaging or challenging you (checked on every such write).
//
// A report stores the reported text as the server reads it, never as the
// reporter sends it, and there is one report per person per item.
//
// Socket events:
//   block        { userId, on }   → { blocked, blockedIds }
//   blockedList                   → { users }
//   report       { type, targetId, reason, details?, context? }

const core = require('./core');
const { severFollows } = require('./follows');

const REPORT_TYPES = {
  post: 'Post',
  comment: 'Comment',
  user: 'Profile',
  message: 'Direct message',
  live_message: 'Live debate message',
  debate_turn: '1-on-1 debate turn',
  audience_message: 'Audience chat message'
};
const MAX_REASON = 100;
const MAX_DETAILS = 500;
const MAX_BLOCKS = 2000;

// The reported item as stored: who wrote it and what it says.
async function resolveTarget(type, targetId, context, reporterId) {
  const db = core.requireDb();
  const read = async (ref, authorField = 'authorId') => {
    const snap = await ref.get();
    if (!snap.exists) throw core.clientError('not_found');
    const data = snap.data() || {};
    return { targetUserId: data[authorField] || null, text: core.clip(data.text || '', 2000) };
  };

  switch (type) {
    case 'post':
      return read(db.collection('posts').doc(core.requireId(targetId)));
    case 'comment':
      return read(db.collection('comments').doc(core.requireId(targetId)));
    case 'user': {
      const uid = core.requireUid(targetId);
      const snap = await db.collection('publicProfiles').doc(uid).get();
      if (!snap.exists) throw core.clientError('not_found');
      return { targetUserId: uid, text: core.clip(`${snap.get('name') || ''} @${snap.get('username') || ''}\n${snap.get('bio') || ''}`, 2000) };
    }
    case 'message': {
      const chatId = typeof context.chatId === 'string' && /^[A-Za-z0-9_-]{1,300}$/.test(context.chatId) ? context.chatId : null;
      if (!chatId || typeof targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(targetId)) throw core.clientError('bad_request');
      const chat = await db.collection('chats').doc(chatId).get();
      const participants = chat.exists ? chat.get('participants') : null;
      if (!Array.isArray(participants) || !participants.includes(reporterId)) throw core.clientError('not_allowed');
      return read(db.collection('chats').doc(chatId).collection('messages').doc(targetId), 'senderId');
    }
    case 'live_message': {
      if (!core.DAY_KEY_RE.test(context.topicId || '')) throw core.clientError('bad_request');
      return read(
        db.collection('dailyTopics').doc(context.topicId).collection('liveMessages').doc(core.requireId(targetId)),
        'userId'
      );
    }
    case 'debate_turn': {
      const debateId = core.requireId(context.debateId);
      if (typeof targetId !== 'string' || !/^\d{2}$/.test(targetId)) throw core.clientError('bad_request');
      return read(db.collection('challengeDebates').doc(debateId).collection('turns').doc(targetId), 'userId');
    }
    case 'audience_message': {
      const debateId = core.requireId(context.debateId);
      return read(db.collection('challengeDebates').doc(debateId).collection('audience').doc(core.requireId(targetId)), 'userId');
    }
    default:
      throw core.clientError('bad_request');
  }
}

function register({ io, on, userId }) {
  on('block', async (payload) => {
    const targetId = core.requireUid(payload.userId);
    const turnOn = payload.on !== false;
    if (targetId === userId) throw core.clientError('bad_request');
    await core.rateLimit('block', userId, 60, 60 * 1000);

    const ref = core.blocksRef(core.requireDb(), userId).doc(targetId);
    if (turnOn) {
      const target = await core.getUser(targetId);
      await ref.set({
        blockedUserId: targetId,
        blockedUserName: target && !target.missing ? target.name : '',
        source: 'app',
        createdAt: core.FieldValue().serverTimestamp()
      });
      await severFollows(userId, targetId);
      await require('./challenges').withdrawBetween(io, userId, targetId);
    } else {
      await ref.delete();
    }
    core.forgetBlocks(userId);
    const blocked = await core.blockedBy(userId);
    io.to(core.userRoom(userId)).emit('blocksChanged', { blockedIds: [...blocked] });
    return { blocked: turnOn, blockedIds: [...blocked] };
  });

  on('blockedList', async () => {
    const snap = await core.blocksRef(core.requireDb(), userId).orderBy('createdAt', 'desc').limit(MAX_BLOCKS).get();
    const ids = snap.docs.map((d) => d.id);
    const users = await core.getUsers(ids);
    return { users: ids.map((id) => users.get(id)).filter(Boolean) };
  });

  on('report', async (payload) => {
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (!REPORT_TYPES[type]) throw core.clientError('bad_request');
    const reason = core.cleanLine(payload.reason).slice(0, MAX_REASON);
    if (!reason) throw core.clientError('bad_request');
    const details = core.clip(core.cleanText(payload.details || ''), MAX_DETAILS);
    const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
    await core.rateLimit('report', userId, 30, 60 * 60 * 1000);

    const target = await resolveTarget(type, payload.targetId, context, userId);
    if (target.targetUserId === userId) throw core.clientError('own_content');

    const id = `${userId}_${type}_${String(payload.targetId).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 400);
    const [reporter, reported] = await Promise.all([core.getUser(userId), core.getUser(target.targetUserId)]);
    const safeContext = {};
    for (const key of ['postId', 'chatId', 'topicId', 'debateId']) {
      if (typeof context[key] === 'string' && context[key].length <= 300) safeContext[key] = context[key];
    }
    await core
      .requireDb()
      .collection('socialReports')
      .doc(id)
      .set({
        id,
        reporterId: userId,
        reporterName: reporter ? reporter.name : '',
        targetType: type,
        contentType: REPORT_TYPES[type],
        targetId: String(payload.targetId),
        targetUserId: target.targetUserId,
        targetUserName: reported && !reported.missing ? reported.name : '',
        text: target.text,
        reason,
        details,
        context: safeContext,
        roomId: safeContext.topicId || safeContext.debateId || safeContext.postId || safeContext.chatId || null,
        status: 'open',
        createdAt: core.FieldValue().serverTimestamp()
      });
    return {};
  });
}

module.exports = { register };
