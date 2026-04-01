import fs from "fs";
import path from "path";
import { LocksFile, QueueFile, MutexFile, LockEntry, QueueEntry } from "../types/index.js";
import { isProcessAlive, getCurrentBranch } from "./git.js";

const MUTEX_MAX_AGE_MS = 5000;
const MUTEX_RETRY_DELAY_MS = 100;
const MUTEX_MAX_ATTEMPTS = 50;

function getMutexPath(agentsDir: string): string {
  return path.join(agentsDir, "locks.json.lock");
}

function getLocksPath(agentsDir: string): string {
  return path.join(agentsDir, "locks.json");
}

function getQueuePath(agentsDir: string): string {
  return path.join(agentsDir, "queue.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquire the filesystem mutex over locks.json (and queue.json). */
async function acquireMutex(agentsDir: string): Promise<void> {
  const mutexPath = getMutexPath(agentsDir);

  for (let attempt = 0; attempt < MUTEX_MAX_ATTEMPTS; attempt++) {
    try {
      // O_CREAT | O_EXCL — atomic on POSIX
      const fd = fs.openSync(mutexPath, "wx");
      const data: MutexFile = { pid: process.pid, ts: Date.now() };
      fs.writeSync(fd, JSON.stringify(data));
      fs.closeSync(fd);
      return; // acquired
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      // Check if mutex holder is dead or stale
      try {
        const raw = fs.readFileSync(mutexPath, "utf8");
        const mutex: MutexFile = JSON.parse(raw);
        const isStale = Date.now() - mutex.ts > MUTEX_MAX_AGE_MS;
        const isDead = !isProcessAlive(mutex.pid);
        if (isStale || isDead) {
          fs.unlinkSync(mutexPath);
          continue; // retry immediately
        }
      } catch {
        // mutex file disappeared or unreadable — retry
        continue;
      }

      await sleep(MUTEX_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Could not acquire lock mutex after ${MUTEX_MAX_ATTEMPTS} attempts. ` +
      `If a previous gss process crashed, delete ${mutexPath} manually.`
  );
}

function releaseMutex(agentsDir: string): void {
  try {
    fs.unlinkSync(getMutexPath(agentsDir));
  } catch {
    // already gone — that's fine
  }
}

function readLocksFile(agentsDir: string): LocksFile {
  const p = getLocksPath(agentsDir);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as LocksFile;
  } catch {
    return { version: 1, locks: {} };
  }
}

function writeLocksFile(agentsDir: string, data: LocksFile): void {
  const p = getLocksPath(agentsDir);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function readQueueFile(agentsDir: string): QueueFile {
  const p = getQueuePath(agentsDir);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as QueueFile;
  } catch {
    return { version: 1, queue: [] };
  }
}

function writeQueueFile(agentsDir: string, data: QueueFile): void {
  const p = getQueuePath(agentsDir);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function normalizeFilePath(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}

/**
 * Acquire an exclusive lock on a file.
 * Returns null on success, or an error message string on failure.
 */
export async function acquireFileLock(
  agentsDir: string,
  agentId: string,
  rawFilePath: string
): Promise<string | null> {
  const filePath = normalizeFilePath(rawFilePath);
  const branch = getCurrentBranch();

  await acquireMutex(agentsDir);
  try {
    const locksData = readLocksFile(agentsDir);
    const existing = locksData.locks[filePath];

    // Shell session PID (ppid) is stable across multiple gss invocations in the same terminal
    const shellPid = process.ppid;

    if (existing) {
      if (existing.agentId === agentId) {
        // idempotent — we already own this lock
        return null;
      }

      if (!isProcessAlive(existing.pid)) {
        // dead agent — reclaim the lock
        delete locksData.locks[filePath];
        // fall through to acquire below
      } else {
        // legitimately locked — add to queue and return error
        const queueData = readQueueFile(agentsDir);
        const alreadyQueued = queueData.queue.some(
          (e) => e.filePath === filePath && e.agentId === agentId
        );
        if (!alreadyQueued) {
          const entry: QueueEntry = {
            agentId,
            pid: shellPid,
            branch,
            filePath,
            requestedAt: new Date().toISOString(),
          };
          queueData.queue.push(entry);
          writeQueueFile(agentsDir, queueData);
        }
        return (
          `File ${filePath} is locked by Agent [${existing.agentId}] on branch ${existing.branch}`
        );
      }
    }

    // Acquire the lock — store shell session PID for liveness checks
    const entry: LockEntry = {
      agentId,
      pid: shellPid,
      branch,
      timestamp: new Date().toISOString(),
    };
    locksData.locks[filePath] = entry;
    writeLocksFile(agentsDir, locksData);

    // Remove from queue if present
    const queueData = readQueueFile(agentsDir);
    queueData.queue = queueData.queue.filter(
      (e) => !(e.filePath === filePath && e.agentId === agentId)
    );
    writeQueueFile(agentsDir, queueData);

    return null;
  } finally {
    releaseMutex(agentsDir);
  }
}

/**
 * Release a file lock.
 * Returns true if the lock was released, false if we didn't own it.
 */
export async function releaseFileLock(
  agentsDir: string,
  agentId: string,
  rawFilePath: string
): Promise<boolean> {
  const filePath = normalizeFilePath(rawFilePath);

  await acquireMutex(agentsDir);
  try {
    const locksData = readLocksFile(agentsDir);
    const existing = locksData.locks[filePath];

    if (!existing) return false;
    if (existing.agentId !== agentId) return false;

    delete locksData.locks[filePath];
    writeLocksFile(agentsDir, locksData);
    return true;
  } finally {
    releaseMutex(agentsDir);
  }
}

/** Release ALL locks held by this agent (called on cleanup). */
export async function releaseAllLocks(
  agentsDir: string,
  agentId: string
): Promise<string[]> {
  await acquireMutex(agentsDir);
  try {
    const locksData = readLocksFile(agentsDir);
    const released: string[] = [];

    for (const [filePath, entry] of Object.entries(locksData.locks)) {
      if (entry.agentId === agentId) {
        delete locksData.locks[filePath];
        released.push(filePath);
      }
    }

    if (released.length > 0) writeLocksFile(agentsDir, locksData);
    return released;
  } finally {
    releaseMutex(agentsDir);
  }
}

/** Read current locks (no mutex needed — worst case is a stale read). */
export function readLocks(agentsDir: string): LocksFile {
  return readLocksFile(agentsDir);
}

/** Read current queue (no mutex needed for read). */
export function readQueue(agentsDir: string): QueueFile {
  return readQueueFile(agentsDir);
}

/** Check if a file is currently locked by someone other than us. */
export function isFileLocked(agentsDir: string, rawFilePath: string): LockEntry | null {
  const filePath = normalizeFilePath(rawFilePath);
  const locksData = readLocksFile(agentsDir);
  const entry = locksData.locks[filePath];
  if (!entry) return null;
  if (!isProcessAlive(entry.pid)) return null; // dead agent
  return entry;
}
