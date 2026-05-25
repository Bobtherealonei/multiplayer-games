// Fail the deploy early if protobufjs cannot load (broken installs break Firestore).
'use strict';

try {
  const pb = require('protobufjs');
  if (!pb || typeof pb.Reader !== 'function') {
    throw new Error('protobufjs export missing Reader');
  }
  console.log('[postinstall] protobufjs OK');
} catch (err) {
  console.error('[postinstall] protobufjs failed to load:', err.message);
  process.exit(1);
}
