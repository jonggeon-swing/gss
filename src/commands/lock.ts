import path from "path";
import { getProjectRoot } from "../core/git.js";
import { acquireFileLock } from "../core/lock-manager.js";
import { addLockedFile } from "../core/status-manager.js";
import { getAgentId } from "../agent-id.js";

export async function runLock(filePath: string): Promise<void> {
  const projectRoot = getProjectRoot();
  const agentsDir = path.join(projectRoot, ".agents");
  const agentId = getAgentId();

  const error = await acquireFileLock(agentsDir, agentId, filePath);

  if (error) {
    console.error(`ERROR: ${error}`);
    process.exit(1);
  }

  const absPath = path.resolve(process.cwd(), filePath);
  addLockedFile(agentsDir, agentId, absPath);

  console.log(`Lock acquired: ${absPath}`);
}
