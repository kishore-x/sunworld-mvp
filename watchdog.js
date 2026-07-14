// Self-restart watchdog — runs server.js as a child process and automatically respawns it if it
// ever exits unexpectedly (crash, uncaught error that somehow still kills the process, etc).
// Uses an increasing backoff so a broken deploy doesn't restart-loop hundreds of times a minute.
// No PM2/external tool needed — this is the whole "keep it running" mechanism.
const { spawn } = require('child_process');
const path = require('path');

const SERVER_FILE = path.join(__dirname, 'server.js');
const MAX_BACKOFF_MS = 30000;
let backoff = 1000;
let restarts = 0;

function start(){
  console.log(`[watchdog] starting server.js (restart #${restarts})`);
  const child = spawn(process.execPath, [SERVER_FILE], { stdio: 'inherit' });

  const startedAt = Date.now();
  child.on('exit', (code, signal) => {
    const ranMs = Date.now() - startedAt;
    console.error(`[watchdog] server.js exited (code=${code} signal=${signal}) after ${Math.round(ranMs/1000)}s`);
    // if it ran for a while before dying, treat this as a fresh problem and reset backoff
    if(ranMs > 60000) backoff = 1000;
    restarts++;
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  });
}

process.on('SIGINT', ()=>process.exit(0));
process.on('SIGTERM', ()=>process.exit(0));

start();
