// socialUtil.js — small helpers shared by the social socket modules
// (topicChat.js now; challenges and takes later).

const { getDb } = require('./firestoreClient');

function serviceError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function requireDb() {
  const db = getDb();
  if (!db) throw serviceError('unavailable');
  return db;
}

// What a client is told when a handler throws: never the raw message.
function publicError(err) {
  return err && err.code === 'unavailable' ? 'unavailable' : 'internal';
}

// Socket.IO handler args (payload?, ack?) → { payload, reply }. The Swift
// client sends its payload wrapped in an array; events sent without an ack
// get a no-op reply.
function unpack(args) {
  const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  const first = args[0];
  const raw = Array.isArray(first) ? first[0] : first;
  const payload = raw && typeof raw === 'object' ? raw : {};
  return { payload, reply: (body) => { if (ack) ack(body); } };
}

module.exports = { serviceError, requireDb, publicError, unpack };
