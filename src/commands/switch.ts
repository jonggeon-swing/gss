import path from "path";
import { getProjectRoot } from "../core/git.js";
import { switchSession } from "../core/session.js";
import { getAgentId } from "../agent-id.js";

export async function runSwitch(targetBranch: string): Promise<void> {
  const projectRoot = getProjectRoot();
  const agentsDir = path.join(projectRoot, ".agents");
  const agentId = getAgentId();

  const result = await switchSession(agentsDir, agentId, targetBranch);

  // Emit shell exports to stdout so the caller can eval them
  for (const line of result.shellExports) {
    process.stdout.write(line + "\n");
  }

  // Status output goes to stderr so it doesn't pollute the eval
  const stderr = process.stderr;
  stderr.write(`Switched to branch: ${result.branch}\n`);

  if (result.stashedFrom) {
    stderr.write(`Stashed changes from: ${result.stashedFrom}\n`);
  }
  if (result.stashRestored) {
    stderr.write(`Restored previous session stash\n`);
  }
  if (result.shadowIndexActive) {
    stderr.write(`Shadow index active: GIT_INDEX_FILE set\n`);
  }
  if (result.hasConflict) {
    stderr.write(`WARNING: Stash pop had conflicts — resolve before continuing\n`);
  }
}
