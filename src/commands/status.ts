import path from "path";
import { getProjectRoot, isProcessAlive } from "../core/git.js";
import { readStatus } from "../core/status-manager.js";
import { readLocks, readQueue } from "../core/lock-manager.js";

export function runStatus(): void {
  const projectRoot = getProjectRoot();
  const agentsDir = path.join(projectRoot, ".agents");

  const agents = readStatus(agentsDir);
  const locksData = readLocks(agentsDir);
  const queueData = readQueue(agentsDir);

  const agentEntries = Object.entries(agents);
  const lockEntries = Object.entries(locksData.locks);

  console.log("─────────────────────────────────────────");
  console.log("  GSS — Git Shadow Session Status");
  console.log("─────────────────────────────────────────");
  console.log();

  if (agentEntries.length === 0) {
    console.log("No active agents.");
  } else {
    console.log(`Agents (${agentEntries.length}):`);
    for (const [agentId, status] of agentEntries) {
      const alive = isProcessAlive(status.pid);
      const aliveStr = alive ? "alive" : "DEAD";
      const conflictStr = status.hasConflict ? " ⚠ CONFLICT" : "";
      console.log(
        `  ${agentId}  [${aliveStr}]  branch: ${status.branch}${conflictStr}`
      );
      console.log(`    PID: ${status.pid}  started: ${status.startedAt}`);
      console.log(`    last seen: ${status.lastSeen}`);
      if (status.lockedFiles.length > 0) {
        console.log(`    locked files:`);
        for (const f of status.lockedFiles) {
          console.log(`      - ${f}`);
        }
      }
    }
  }

  console.log();
  console.log(`File Locks (${lockEntries.length}):`);
  if (lockEntries.length === 0) {
    console.log("  (none)");
  } else {
    for (const [filePath, lock] of lockEntries) {
      const alive = isProcessAlive(lock.pid);
      const aliveStr = alive ? "" : " [DEAD — can be reclaimed]";
      console.log(`  ${path.relative(projectRoot, filePath)}`);
      console.log(
        `    held by ${lock.agentId} (PID ${lock.pid}) on branch ${lock.branch}${aliveStr}`
      );
      console.log(`    since: ${lock.timestamp}`);
    }
  }

  console.log();
  if (queueData.queue.length > 0) {
    console.log(`Waiting Queue (${queueData.queue.length}):`);
    for (const entry of queueData.queue) {
      console.log(
        `  ${entry.agentId} waiting for ${path.relative(projectRoot, entry.filePath)} (since ${entry.requestedAt})`
      );
    }
  }

  console.log("─────────────────────────────────────────");
}
