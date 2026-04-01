import fs from "fs";
import path from "path";
import {
  getProjectRoot,
  getCurrentBranch,
  branchExists,
  hasUncommittedChanges,
  stashPush,
  findSessionStash,
  stashPop,
  checkout,
  shadowIndexExists,
  copyShadowIndexSync,
} from "./git.js";
import { registerAgent, updateAgentBranch, setConflict } from "./status-manager.js";
import { MutexFile } from "../types/index.js";

const SWITCH_MUTEX_MAX_AGE_MS = 30_000; // 30 seconds for checkout operations
const SWITCH_MUTEX_RETRY_DELAY_MS = 200;
const SWITCH_MUTEX_MAX_ATTEMPTS = 100;

function getSwitchMutexPath(agentsDir: string): string {
  return path.join(agentsDir, "switch.lock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireSwitchMutex(agentsDir: string): Promise<void> {
  const mutexPath = getSwitchMutexPath(agentsDir);

  for (let attempt = 0; attempt < SWITCH_MUTEX_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(mutexPath, "wx");
      const data: MutexFile = { pid: process.pid, ts: Date.now() };
      fs.writeSync(fd, JSON.stringify(data));
      fs.closeSync(fd);
      return;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      try {
        const raw = fs.readFileSync(mutexPath, "utf8");
        const mutex: MutexFile = JSON.parse(raw);
        const isStale = Date.now() - mutex.ts > SWITCH_MUTEX_MAX_AGE_MS;
        const isDead = !isProcessAlive(mutex.pid);
        if (isStale || isDead) {
          fs.unlinkSync(mutexPath);
          continue;
        }
      } catch {
        continue;
      }

      await sleep(SWITCH_MUTEX_RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Another agent is switching branches. Waited ${(SWITCH_MUTEX_MAX_ATTEMPTS * SWITCH_MUTEX_RETRY_DELAY_MS) / 1000}s. ` +
      `Delete ${getSwitchMutexPath(agentsDir)} if this is stale.`
  );
}

function releaseSwitchMutex(agentsDir: string): void {
  try {
    fs.unlinkSync(getSwitchMutexPath(agentsDir));
  } catch {
    // already gone
  }
}

function getIndexPath(agentsDir: string, branch: string): string {
  // encode branch name for filesystem safety
  const safe = branch.replace(/\//g, "%2F").replace(/[^a-zA-Z0-9._%-]/g, "_");
  return path.join(agentsDir, `index-${safe}`);
}

export interface SwitchResult {
  branch: string;
  stashedFrom: string | null;
  stashRestored: boolean;
  shadowIndexActive: boolean;
  hasConflict: boolean;
  /** Shell commands to eval in the parent shell (for GIT_INDEX_FILE) */
  shellExports: string[];
}

export async function switchSession(
  agentsDir: string,
  agentId: string,
  targetBranch: string
): Promise<SwitchResult> {
  // ── Phase 0: Preconditions ────────────────────────────────────────────────
  const projectRoot = getProjectRoot();

  if (!fs.existsSync(path.join(agentsDir, "status.json"))) {
    throw new Error(
      'GSS not initialized. Run "gss init" in your project root first.'
    );
  }

  const currentBranch = getCurrentBranch();

  if (currentBranch === targetBranch) {
    // Just update heartbeat
    updateAgentBranch(agentsDir, agentId, targetBranch);
    return {
      branch: targetBranch,
      stashedFrom: null,
      stashRestored: false,
      shadowIndexActive: false,
      hasConflict: false,
      shellExports: [],
    };
  }

  if (!branchExists(targetBranch)) {
    throw new Error(`Branch "${targetBranch}" does not exist. Create it first with git checkout -b.`);
  }

  // Serialize all switch operations
  await acquireSwitchMutex(agentsDir);

  let stashedFrom: string | null = null;
  let stashRestored = false;
  let shadowIndexActive = false;
  let hasConflict = false;
  const shellExports: string[] = [];

  try {
    // ── Phase 1: Save current session ────────────────────────────────────────
    if (hasUncommittedChanges()) {
      stashPush(currentBranch);
      stashedFrom = currentBranch;
    }

    // Save shadow index if active
    const currentGitIndex = process.env["GIT_INDEX_FILE"];
    if (currentGitIndex) {
      const savedIndexPath = getIndexPath(agentsDir, currentBranch);
      copyShadowIndexSync(currentGitIndex, savedIndexPath);
    }

    // ── Phase 2: Checkout ─────────────────────────────────────────────────────
    try {
      checkout(targetBranch);
    } catch (e) {
      // Rollback: restore stash
      if (stashedFrom !== null) {
        const stashRef = findSessionStash(stashedFrom);
        if (stashRef) stashPop(stashRef);
      }
      throw e;
    }

    // ── Phase 3: Restore target session ──────────────────────────────────────
    const targetIndexPath = getIndexPath(agentsDir, targetBranch);
    if (shadowIndexExists(targetIndexPath)) {
      shellExports.push(`export GIT_INDEX_FILE="${targetIndexPath}"`);
      shadowIndexActive = true;
    }

    const stashRef = findSessionStash(targetBranch);
    if (stashRef) {
      const result = stashPop(stashRef);
      stashRestored = result.success;
      if (!result.success) {
        hasConflict = true;
        // Non-fatal: let the agent resolve conflicts
        console.warn(
          `Warning: stash pop had conflicts. Resolve them before continuing.\n${result.stderr}`
        );
      }
    }

    // ── Phase 4: Update state ─────────────────────────────────────────────────
    registerAgent(agentsDir, agentId, targetBranch);
    if (hasConflict) {
      setConflict(agentsDir, agentId, true);
    }

    return { branch: targetBranch, stashedFrom, stashRestored, shadowIndexActive, hasConflict, shellExports };
  } finally {
    releaseSwitchMutex(agentsDir);
  }
}
