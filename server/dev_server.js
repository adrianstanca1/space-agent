#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CURRENT_DIR, "..");
const WATCH_TARGETS = ["space", "commands", "server"].map((entry) => path.join(PROJECT_ROOT, entry));
const SCAN_INTERVAL_MS = 750;
const RESTART_DEBOUNCE_MS = 1_000;
const SHUTDOWN_GRACE_MS = 2_000;
const MAX_PENDING_RESTART_REASONS = 1000;

let childProcess = null;
let currentSnapshot = "";
let scanTimer = null;
let restartDebounceTimer = null;
let scanInProgress = false;
let isShuttingDown = false;
let isRestartInProgress = false;
let hardKillTimer = null;
let pendingRestartReasons = new Set();

function toRelativePath(targetPath) {
  return path.relative(PROJECT_ROOT, targetPath) || ".";
}

async function readStats(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function collectSnapshotEntries(targetPath, entries) {
  const stats = await readStats(targetPath);
  if (!stats) {
    return;
  }

  if (stats.isDirectory()) {
    const children = await fs.readdir(targetPath, { withFileTypes: true });

    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      if (child.name.startsWith(".")) {
        continue;
      }

      await collectSnapshotEntries(path.join(targetPath, child.name), entries);
    }

    return;
  }

  if (!stats.isFile()) {
    return;
  }

  entries.push(`${toRelativePath(targetPath)}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
}

async function buildSnapshot() {
  const entries = [];

  for (const watchTarget of WATCH_TARGETS) {
    await collectSnapshotEntries(watchTarget, entries);
  }

  return entries.join("\n");
}

function describeSnapshotChange(previousSnapshot, nextSnapshot) {
  const previousEntries = new Set(previousSnapshot ? previousSnapshot.split("\n") : []);
  const nextEntries = new Set(nextSnapshot ? nextSnapshot.split("\n") : []);

  for (const entry of nextEntries) {
    if (!previousEntries.has(entry)) {
      return entry.split(":")[0];
    }
  }

  for (const entry of previousEntries) {
    if (!nextEntries.has(entry)) {
      return entry.split(":")[0];
    }
  }

  return "watched sources";
}

function clearHardKillTimer() {
  if (hardKillTimer) {
    clearTimeout(hardKillTimer);
    hardKillTimer = null;
  }
}

function clearRestartDebounceTimer() {
  if (restartDebounceTimer) {
    clearTimeout(restartDebounceTimer);
    restartDebounceTimer = null;
  }
}

function formatPendingRestartReason() {
  const reasons = [...pendingRestartReasons].sort((left, right) => left.localeCompare(right));

  if (reasons.length === 0) {
    return "watched sources";
  }

  if (reasons.length === 1) {
    return reasons[0];
  }

  if (reasons.length === 2) {
    return `${reasons[0]} and ${reasons[1]}`;
  }

  return `${reasons[0]} and ${reasons.length - 1} other files`;
}

function scheduleHardKill(child) {
  clearHardKillTimer();

  hardKillTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, SHUTDOWN_GRACE_MS);
}

function startServerProcess() {
  const args = [path.join(PROJECT_ROOT, "space"), "serve", ...process.argv.slice(2)];

  childProcess = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit"
  });

  childProcess.once("exit", (code, signal) => {
    childProcess = null;
    clearHardKillTimer();

    if (isShuttingDown) {
      process.exit(code ?? 0);
      return;
    }

    if (isRestartInProgress) {
      isRestartInProgress = false;
      startServerProcess();
      return;
    }

    const exitLabel = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[dev] Serve process exited with ${exitLabel}. Watching for changes...`);
  });
}

function requestRestart(reason) {
  if (isShuttingDown) {
    return;
  }

  if (isRestartInProgress) {
    scheduleRestart(reason);
    return;
  }

  console.log(`[dev] Change detected in ${reason}. Restarting server...`);

  if (!childProcess) {
    startServerProcess();
    return;
  }

  isRestartInProgress = true;
  childProcess.kill("SIGTERM");
  scheduleHardKill(childProcess);
}

function flushScheduledRestart() {
  clearRestartDebounceTimer();

  if (pendingRestartReasons.size === 0 || isShuttingDown) {
    return;
  }

  const reason = formatPendingRestartReason();
  pendingRestartReasons = new Set();
  requestRestart(reason);
}

function scheduleRestart(reason) {
  if (isShuttingDown) {
    return;
  }

  if (pendingRestartReasons.size >= MAX_PENDING_RESTART_REASONS) {
    const oldestKey = pendingRestartReasons.values().next().value;
    pendingRestartReasons.delete(oldestKey);
  }

  pendingRestartReasons.add(reason);
  clearRestartDebounceTimer();

  restartDebounceTimer = setTimeout(() => {
    flushScheduledRestart();
  }, RESTART_DEBOUNCE_MS);
}

async function scanForChanges() {
  if (scanInProgress || isShuttingDown) {
    return;
  }

  scanInProgress = true;

  try {
    const nextSnapshot = await buildSnapshot();

    if (!currentSnapshot) {
      currentSnapshot = nextSnapshot;
      return;
    }

    if (nextSnapshot !== currentSnapshot) {
      const changedPath = describeSnapshotChange(currentSnapshot, nextSnapshot);
      currentSnapshot = nextSnapshot;
      scheduleRestart(changedPath);
    }
  } catch (error) {
    console.error("[dev] Failed to scan watch targets.");
    console.error(error);
  } finally {
    scanInProgress = false;
  }
}

function startWatching() {
  scanTimer = setInterval(() => {
    void scanForChanges();
  }, SCAN_INTERVAL_MS);
}

function stopWatching() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  stopWatching();
  clearRestartDebounceTimer();

  if (!childProcess) {
    process.exit(0);
    return;
  }

  childProcess.kill("SIGTERM");
  scheduleHardKill(childProcess);
}

async function main() {
  currentSnapshot = await buildSnapshot();
  console.log("[dev] Watching space, commands/, and server/ for server restarts.");
  startServerProcess();
  startWatching();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("[dev] Failed to start the development server.");
  console.error(error);
  process.exit(1);
});
