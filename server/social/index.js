// social/index.js — wires the social features into the socket server.
//
// `register` runs once per connection, before anything is awaited, so the
// handlers are in place for the first request the app sends. `start` runs
// once per instance and starts the background work: the debate turn clock,
// challenge expiry, the midnight topic change, and cleaning up after
// deleted accounts.

const core = require('./core');

const modules = [
  require('./profiles'),
  require('./follows'),
  require('./posts'),
  require('./comments'),
  require('./notifications'),
  require('./safety'),
  require('./dms'),
  require('./challenges'),
  require('./debates'),
  require('./live'),
  require('./purge')
];

function register(io, socket, userId) {
  // Live updates only go to sockets that proved who they are.
  if (socket.data.authenticated) {
    socket.join(core.ROOM_ALL);
    socket.join(core.userRoom(userId));
  }
  const context = { io, socket, userId, on: core.makeOn(socket, userId) };
  for (const module of modules) module.register(context);
}

function start(io) {
  require('./debates').start(io);
  require('./challenges').start(io);
  require('./live').start(io);
  require('./purge').start(io);
}

function stop() {
  require('./debates').stop();
  require('./challenges').stop();
  require('./live').stop();
  require('./purge').stop();
}

module.exports = { register, start, stop };
