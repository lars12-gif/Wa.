'use strict';

// Small process supervisor for hosting environments that run a user command.
// Prefer the hosting panel's own "always restart" option as well.
const { spawn } = require('node:child_process');
const path = require('node:path');

const ENTRY_FILE = path.join(__dirname, 'index.js');
const MIN_RESTART_DELAY_MS = 1500;
const MAX_RESTART_DELAY_MS = 30000;
const STABLE_RUNTIME_MS = 5 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 10000;

let child = null;
let stopping = false;
let restartTimer = null;
let forceStopTimer = null;
let restartAttempt = 0;
let childGeneration = 0;

function scheduleRestart(reason) {
    if (stopping || restartTimer) return;
    restartAttempt += 1;
    const exponential = Math.min(
        MAX_RESTART_DELAY_MS,
        MIN_RESTART_DELAY_MS * (2 ** Math.min(restartAttempt - 1, 6))
    );
    const jitter = Math.floor(Math.random() * 1000);
    const delay = Math.min(MAX_RESTART_DELAY_MS, exponential + jitter);
    process.stderr.write(
        `[RUNNER] Child exited unexpectedly; restarting in ${delay}ms ` +
        `(attempt ${restartAttempt}). Reason: ${reason}\n`
    );
    restartTimer = setTimeout(() => {
        restartTimer = null;
        launchChild();
    }, delay);
}

function launchChild() {
    if (stopping) return;
    const generation = ++childGeneration;
    let eventHandled = false;
    const startedAt = Date.now();

    process.stdout.write(`[RUNNER] Starting ARTHUR (generation ${generation})\n`);
    const nextChild = spawn(process.execPath, [ENTRY_FILE], {
        cwd: __dirname,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true
    });
    child = nextChild;

    const stableTimer = setTimeout(() => {
        if (child === nextChild && !stopping) restartAttempt = 0;
    }, STABLE_RUNTIME_MS);
    stableTimer.unref?.();

    nextChild.once('error', error => {
        if (eventHandled) return;
        eventHandled = true;
        clearTimeout(stableTimer);
        if (child === nextChild) child = null;
        scheduleRestart(`spawn error: ${error.message}`);
    });

    nextChild.once('exit', (code, signal) => {
        clearTimeout(stableTimer);
        if (child === nextChild) child = null;
        if (stopping || eventHandled) return;
        eventHandled = true;
        const runtimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
        scheduleRestart(`exit code=${code}, signal=${signal || 'none'}, runtime=${runtimeSeconds}s`);
    });
}

function stopRunner(signal) {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`[RUNNER] Received ${signal}; stopping child cleanly.\n`);
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }

    if (!child) {
        process.exit(0);
        return;
    }

    const currentChild = child;
    try { currentChild.kill(signal); } catch {}
    forceStopTimer = setTimeout(() => {
        try { currentChild.kill('SIGKILL'); } catch {}
        process.exit(0);
    }, SHUTDOWN_GRACE_MS);

    currentChild.once('exit', () => {
        if (forceStopTimer) clearTimeout(forceStopTimer);
        process.exit(0);
    });
}

process.once('SIGTERM', () => stopRunner('SIGTERM'));
process.once('SIGINT', () => stopRunner('SIGINT'));

launchChild();
