import path from "path";
import { getProjectRoot } from "../core/git.js";
import { isFileLocked, acquireFileLock } from "../core/lock-manager.js";
import { addLockedFile } from "../core/status-manager.js";
import { getAgentId } from "../agent-id.js";

const POLL_INTERVAL_MS = 500;

export async function runWait(
  filePath: string,
  timeoutMs: number = 60_000
): Promise<void> {
  const projectRoot = getProjectRoot();
  const agentsDir = path.join(projectRoot, ".agents");
  const agentId = getAgentId();
  const absPath = path.resolve(process.cwd(), filePath);

  const started = Date.now();

  process.stderr.write(`Waiting for lock on ${absPath}...\n`);

  while (true) {
    const lock = isFileLocked(agentsDir, absPath);

    if (!lock) {
      // File is free — try to acquire
      const error = await acquireFileLock(agentsDir, agentId, absPath);
      if (!error) {
        addLockedFile(agentsDir, agentId, absPath);
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`Lock acquired: ${absPath} (waited ${elapsed}s)`);
        return;
      }
      // Race condition: someone else got it — keep waiting
    }

    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) {
      console.error(
        `ERROR: Timeout waiting for lock on ${absPath} after ${timeoutMs / 1000}s`
      );
      process.exit(1);
    }

    // Show current lock holder
    if (lock) {
      process.stderr.write(
        `\rWaiting... locked by Agent [${lock.pid}] on branch ${lock.branch} (${Math.round(elapsed / 1000)}s elapsed)`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
