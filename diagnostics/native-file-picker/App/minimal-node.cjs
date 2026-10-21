'use strict';

// A single private readiness write proves actual embedded JavaScript execution.
// No server, WebKit, user data, environment dump, or repeated filesystem writes.
const fs = require('node:fs');
const destination = process.argv[2];
if (!destination) throw new Error('Readiness destination is required');
const staging = destination + '.partial';
fs.writeFileSync(staging, JSON.stringify({
  ready: true,
  mode: 'node-on',
  pid: process.pid,
  cwd: process.cwd(),
  nodeStartInvoked: true,
  nodeVersion: process.version,
}));
fs.renameSync(staging, destination);
setInterval(() => {}, 1000);
