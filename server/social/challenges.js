// social/challenges.js — challenging someone to a one-on-one debate.
//
//   challenges/{id}
//     id, fromId, toId, status 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled',
//     source { type 'post' | 'comment' | 'live' | 'profile', postId?, commentId?, topicId?, messageId? },
//     claim (what will be debated), quote (the comment or message that set it off),
//     challengerSide 'support' | 'oppose', createdAt, expiresAt, respondedAt,
//     debateId, debateStatus, cardId
//   challenges/{id}/reminders/{uid}   { createdAt } — "Remind me" on the thread card
//
// What is debated, and who is on which side:
//   post     the post. Its author supports it; the challenger opposes.
//   comment  the post the comment is on. The challenger picks their side
//            (the commenter gets the other one); the comment is quoted.
//   live     today's topic. The person challenged keeps the side they had
//            when they wrote the message; the challenger takes the other.
//   profile  a claim the challenger writes, with the side they pick.
// So the challenger is always on the opposite side from the person they
// challenged.
//
// A request waits `challenge.expiryHours` for an answer. Accepting it
// starts the debate (social/debates.js) and the person who accepted takes
// the first turn, since they are the one known to be there.
//
// Socket events:
//   challengeSend     { source, toId?, claim?, side? }  → { challenge }
//   challengeRespond  { challengeId, accept }           → { challenge, debateId? }
//   challengeInbox                                      → { incoming, outgoing }
//   challengeGet      { challengeId }                   → { challenge }
//   challengeRemind   { challengeId, on }               → { reminding }
//   challenge         (server → both people)            → { challenge }

const core = require('./core');
const posts = require('./posts');
const comments = require('./comments');
const debates = require('./debates');
const notifications = require('./notifications');

const CHALLENGES = 'challenges';
const SWEEP_MS = 60 * 1000;
const SWEEP_BATCH = 100;
const MAX_REMINDERS = 500;

const col = () => core.requireDb().collection(CHALLENGES);
const ref = (id) => col().doc(id);
const byId = () => core.FieldPath().documentId();
const other = (side) => (side === 'support' ? 'oppose' : 'support');

function requireSide(value) {
  if (value !== 'support' && value !== 'oppose') throw core.clientError('side_required');
  return value;
}

// ── Shapes ─────────────────────────────────────────────────────────────────

function wireOne(c, users, reminding) {
  const expired = c.status === 'pending' && c.expiresAt <= Date.now();
  const out = {
    id: c.id,
    from: users.get(c.fromId),
    to: users.get(c.toId),
    status: expired ? 'expired' : c.status,
    source: c.source,
    claim: c.claim,
    quote: c.quote || null,
    challengerSide: c.challengerSide,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    debateId: c.debateId || null,
    debateStatus: c.debateStatus || null
  };
  if (reminding !== undefined) out.reminding = reminding;
  return out;
}

/** challengeId → the challenge as `viewerId` sees it (for thread and live cards). */
async function wireMany(ids, viewerId) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const db = core.requireDb();
  const [snaps, reminderSnaps] = await Promise.all([
    db.getAll(...unique.map((id) => ref(id))),
    db.getAll(...unique.map((id) => ref(id).collection('reminders').doc(viewerId)))
  ]);
  const docs = snaps.map((s) => (s.exists ? s.data() : null));
  const users = await core.getUsers(docs.filter(Boolean).flatMap((c) => [c.fromId, c.toId]));
  const out = new Map();
  docs.forEach((c, i) => {
    if (c) out.set(c.id, wireOne(c, users, reminderSnaps[i].exists));
  });
  return out;
}

// Tells both people, and whoever has the thread or the live debate open.
async function publish(io, c) {
  const users = await core.getUsers([c.fromId, c.toId]);
  const challenge = wireOne(c, users);
  if (io) {
    io.to(core.userRoom(c.fromId)).to(core.userRoom(c.toId)).emit('challenge', { challenge });
    if (c.source && c.source.postId) comments.pushChallenge(io, c.source.postId, challenge);
    if (c.source && c.source.type === 'live') require('./live').pushChallenge(io, c.source.topicId, challenge);
  }
  return challenge;
}

// ── What is being debated ──────────────────────────────────────────────────

async function resolve(payload, userId, cfg) {
  const source = payload.source && typeof payload.source === 'object' ? payload.source : {};
  const db = core.requireDb();

  switch (source.type) {
    case 'post': {
      const post = await posts.getPost(core.requireId(source.postId));
      if (!post) throw core.clientError('not_found');
      return {
        toId: post.authorId,
        claim: core.clip(post.text, cfg.quoteLength),
        quote: null,
        challengerSide: 'oppose',
        source: { type: 'post', postId: post.id }
      };
    }
    case 'comment': {
      const snap = await comments.ref(core.requireId(source.commentId)).get();
      const comment = snap.exists ? snap.data() : null;
      if (!comment || comment.kind === 'challenge') throw core.clientError('not_found');
      const post = await posts.getPost(comment.postId);
      if (!post) throw core.clientError('not_found');
      return {
        toId: comment.authorId,
        claim: core.clip(post.text, cfg.quoteLength),
        quote: core.clip(comment.text, cfg.quoteLength),
        challengerSide: requireSide(payload.side),
        source: { type: 'comment', postId: post.id, commentId: comment.id }
      };
    }
    case 'live': {
      if (!core.DAY_KEY_RE.test(source.topicId || '')) throw core.clientError('bad_request');
      const topicRef = db.collection('dailyTopics').doc(source.topicId);
      const [topicSnap, messageSnap] = await db.getAll(
        topicRef,
        topicRef.collection('liveMessages').doc(core.requireId(source.messageId))
      );
      const message = messageSnap.exists ? messageSnap.data() : null;
      if (!topicSnap.exists || !message || message.kind === 'challenge') throw core.clientError('not_found');
      return {
        toId: message.userId,
        claim: core.clip(topicSnap.get('statement') || '', cfg.quoteLength),
        quote: core.clip(message.text, cfg.quoteLength),
        challengerSide: other(message.side === 'oppose' ? 'oppose' : 'support'),
        source: { type: 'live', topicId: source.topicId, messageId: message.id }
      };
    }
    case 'profile': {
      return {
        toId: core.requireUid(payload.toId),
        claim: await core.validText(payload.claim, { max: cfg.maxClaimLength, singleLine: true }),
        quote: null,
        challengerSide: requireSide(payload.side),
        source: { type: 'profile' }
      };
    }
    default:
      throw core.clientError('bad_request');
  }
}

// ── State changes ──────────────────────────────────────────────────────────

// Moves a pending challenge to `status`. Returns the updated challenge, or
// null if it was no longer pending.
async function settle(challengeId, status, extra = {}) {
  const db = core.requireDb();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(challengeId));
    const c = snap.exists ? snap.data() : null;
    if (!c || c.status !== 'pending') return null;
    const patch = { status, respondedAt: Date.now(), ...extra };
    tx.update(ref(challengeId), patch);
    return { ...c, ...patch };
  });
}

/** Withdraws every pending challenge between two people (one blocked the other). */
async function withdrawBetween(io, a, b) {
  const snaps = await Promise.all(
    [[a, b], [b, a]].map(([from, to]) =>
      col().where('fromId', '==', from).where('toId', '==', to).where('status', '==', 'pending').limit(20).get()
    )
  );
  for (const doc of snaps.flatMap((s) => s.docs)) {
    const updated = await settle(doc.id, 'cancelled');
    if (updated) await publish(io, updated);
  }
}

/** Withdraws every pending challenge to or from one person (their account is gone). */
async function withdrawAll(io, uid) {
  const snaps = await Promise.all(
    ['fromId', 'toId'].map((field) => col().where(field, '==', uid).where('status', '==', 'pending').limit(200).get())
  );
  for (const doc of snaps.flatMap((s) => s.docs)) {
    const updated = await settle(doc.id, 'cancelled');
    if (updated) await publish(io, updated);
  }
}

/** The debate that came out of a challenge has ended: update its cards. */
async function debateFinished(io, debate) {
  if (!debate.challengeId) return;
  try {
    await ref(debate.challengeId).update({ debateStatus: 'finished' });
    const snap = await ref(debate.challengeId).get();
    if (snap.exists) await publish(io, snap.data());
  } catch (err) {
    console.warn('[challenges] debateFinished failed:', err.message);
  }
}

let sweeper = null;

// Expires requests nobody answered in time.
async function sweep(io) {
  const snap = await col().where('status', '==', 'pending').orderBy(byId(), 'asc').limit(SWEEP_BATCH).get();
  const now = Date.now();
  for (const doc of snap.docs) {
    if (doc.get('expiresAt') > now) continue;
    const updated = await settle(doc.id, 'expired');
    if (updated) await publish(io, updated);
  }
}

function start(io) {
  if (sweeper) return;
  sweeper = setInterval(() => {
    sweep(io).catch((err) => console.error('[challenges] sweep failed:', err.message));
  }, SWEEP_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

function stop() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

// ── Socket events ──────────────────────────────────────────────────────────

function register({ io, on, userId }) {
  on('challengeSend', async (payload) => {
    const cfg = (await core.loadSocialConfig()).challenge;
    const resolved = await resolve(payload, userId, cfg);
    const { toId } = resolved;
    if (toId === userId) throw core.clientError('own_content');
    if (!resolved.claim) throw core.clientError('not_found');

    const target = await core.getUser(toId);
    if (!target || target.missing) throw core.clientError('not_found');
    await core.assertNoBlock(userId, toId);

    const now = Date.now();
    const pending = await col()
      .where('fromId', '==', userId)
      .where('toId', '==', toId)
      .where('status', '==', 'pending')
      .limit(10)
      .get();
    if (pending.docs.some((d) => d.get('expiresAt') > now)) throw core.clientError('already_pending');
    await core.rateLimit('challenge', userId, cfg.maxPerHour, 60 * 60 * 1000);

    const challenge = {
      id: core.newId(now),
      fromId: userId,
      toId,
      status: 'pending',
      source: resolved.source,
      claim: resolved.claim,
      quote: resolved.quote,
      challengerSide: resolved.challengerSide,
      createdAt: now,
      expiresAt: now + cfg.expiryHours * 60 * 60 * 1000,
      respondedAt: null,
      debateId: null,
      debateStatus: null,
      cardId: null
    };
    await ref(challenge.id).create(challenge);

    // The "Challenge sent" card, where the challenge came from.
    try {
      if (challenge.source.postId) {
        challenge.cardId = await comments.addChallengeCard(io, {
          postId: challenge.source.postId,
          challengeId: challenge.id,
          fromId: userId
        });
        await ref(challenge.id).update({ cardId: challenge.cardId });
      } else if (challenge.source.type === 'live') {
        await require('./live').addChallengeCard(io, {
          topicId: challenge.source.topicId,
          challengeId: challenge.id,
          fromId: userId
        });
      }
    } catch (err) {
      console.error('[challengeSend] card failed:', err.message);
    }

    const wire = await publish(io, challenge);
    notifications.notify(io, toId, {
      type: 'challenge',
      actorId: userId,
      challengeId: challenge.id,
      postId: challenge.source.postId || null,
      text: core.clip(challenge.claim, 140)
    });
    return { challenge: { ...wire, reminding: false } };
  });

  on('challengeRespond', async (payload) => {
    const challengeId = core.requireId(payload.challengeId);
    const accept = payload.accept === true;
    const snap = await ref(challengeId).get();
    const current = snap.exists ? snap.data() : null;
    if (!current) throw core.clientError('not_found');
    if (current.toId !== userId) throw core.clientError('not_allowed');
    if (current.status !== 'pending') throw core.clientError('not_pending', { status: current.status });
    if (current.expiresAt <= Date.now()) {
      const expired = await settle(challengeId, 'expired');
      if (expired) await publish(io, expired);
      throw core.clientError('expired');
    }

    if (!accept) {
      const declined = await settle(challengeId, 'declined');
      if (!declined) throw core.clientError('not_pending');
      const wire = await publish(io, declined);
      notifications.notify(io, declined.fromId, { type: 'challenge_declined', actorId: userId, challengeId });
      return { challenge: wire };
    }

    await core.assertNoBlock(userId, current.fromId);
    const [mine, theirs] = await Promise.all([debates.activeDebateId(userId), debates.activeDebateId(current.fromId)]);
    if (mine) throw core.clientError('busy', { debateId: mine });
    if (theirs) throw core.clientError('challenger_busy');

    const accepted = await settle(challengeId, 'accepted');
    if (!accepted) throw core.clientError('not_pending');

    let debate;
    try {
      const challengerSupports = accepted.challengerSide === 'support';
      debate = await debates.create(accepted, {
        supportId: challengerSupports ? accepted.fromId : accepted.toId,
        opposeId: challengerSupports ? accepted.toId : accepted.fromId,
        firstId: userId
      });
    } catch (err) {
      await ref(challengeId).update({ status: 'pending', respondedAt: null });
      throw err;
    }
    accepted.debateId = debate.id;
    accepted.debateStatus = 'live';
    await ref(challengeId).update({ debateId: debate.id, debateStatus: 'live' });

    const wire = await publish(io, accepted);
    notifications.notify(io, accepted.fromId, {
      type: 'challenge_accepted',
      actorId: userId,
      challengeId,
      debateId: debate.id,
      text: core.clip(accepted.claim, 140)
    });
    if (accepted.source.postId) posts.bump(io, accepted.source.postId, 'debateCount', 1).catch(() => {});

    // Everyone who tapped "Remind me" on the card.
    ref(challengeId)
      .collection('reminders')
      .limit(MAX_REMINDERS)
      .select()
      .get()
      .then(async (reminders) => {
        const users = await core.getUsers([accepted.fromId, accepted.toId]);
        const text = `${users.get(accepted.fromId).name} vs ${users.get(accepted.toId).name} is live now`;
        reminders.docs
          .map((d) => d.id)
          .filter((uid) => uid !== accepted.fromId && uid !== accepted.toId)
          .forEach((uid) => {
            notifications.notify(io, uid, {
              type: 'debate_started',
              actorId: accepted.fromId,
              key: debate.id,
              debateId: debate.id,
              text
            });
          });
      })
      .catch((err) => console.warn('[challengeRespond] reminders failed:', err.message));

    return { challenge: wire, debateId: debate.id };
  });

  on('challengeInbox', async () => {
    const [incoming, outgoing, blocked] = await Promise.all([
      col().where('toId', '==', userId).where('status', '==', 'pending').limit(50).get(),
      col().where('fromId', '==', userId).where('status', '==', 'pending').limit(50).get(),
      core.blockedBy(userId)
    ]);
    const docs = [...incoming.docs, ...outgoing.docs].map((d) => d.data());
    const users = await core.getUsers(docs.flatMap((c) => [c.fromId, c.toId]));
    const live = (snap, otherField) =>
      snap.docs
        .map((d) => d.data())
        .filter((c) => !blocked.has(c[otherField]))
        .map((c) => wireOne(c, users))
        .filter((c) => c.status === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt);
    return { incoming: live(incoming, 'fromId'), outgoing: live(outgoing, 'toId') };
  });

  on('challengeGet', async (payload) => {
    const challengeId = core.requireId(payload.challengeId);
    const wired = await wireMany([challengeId], userId);
    if (!wired.has(challengeId)) throw core.clientError('not_found');
    return { challenge: wired.get(challengeId) };
  });

  on('challengeRemind', async (payload) => {
    const challengeId = core.requireId(payload.challengeId);
    const turnOn = payload.on !== false;
    const snap = await ref(challengeId).get();
    const c = snap.exists ? snap.data() : null;
    if (!c) throw core.clientError('not_found');
    if (c.fromId === userId || c.toId === userId) throw core.clientError('own_content');
    const reminder = ref(challengeId).collection('reminders').doc(userId);
    if (turnOn) {
      if (c.status !== 'pending' || c.expiresAt <= Date.now()) throw core.clientError('not_pending', { status: c.status });
      await core.rateLimit('remind', userId, 60, 60 * 1000);
      await reminder.set({ createdAt: Date.now() });
    } else {
      await reminder.delete();
    }
    return { reminding: turnOn };
  });
}

module.exports = { register, start, stop, sweep, wireMany, withdrawBetween, withdrawAll, debateFinished };
