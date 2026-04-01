import path from "path";
import { getProjectRoot } from "../core/git.js";
import { releaseFileLock } from "../core/lock-manager.js";
import { removeLockedFile } from "../core/status-manager.js";
import { getAgentId } from "../agent-id.js";

export async function runRelease(filePath: string): Promise<void> {
  const projectRoot = getProjectRoot();
  const agentsDir = path.join(projectRoot, ".agents");
  const agentId = getAgentId();

  const absPath = path.resolve(process.cwd(), filePath);
  const released = await releaseFileLock(agentsDir, agentId, absPath);

  if (!released) {
    console.error(`ERROR: No lock held by this agent on ${absPath}`);
    process.exit(1);
  }

  removeLockedFile(agentsDir, agentId, absPath);
  console.log(`Lock released: ${absPath}`);
}
