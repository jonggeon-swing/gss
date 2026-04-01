import fs from "fs";
import path from "path";
import { getProjectRoot } from "../core/git.js";
import { LocksFile, QueueFile, StatusFile } from "../types/index.js";

export function runInit(): void {
  const projectRoot = getProjectRoot();
  const agentsDir = path.join(projectRoot, ".agents");

  if (fs.existsSync(agentsDir)) {
    console.log(`GSS already initialized at ${agentsDir}`);
    return;
  }

  fs.mkdirSync(agentsDir, { recursive: true });

  const statusFile: StatusFile = { version: 1, agents: {} };
  const locksFile: LocksFile = { version: 1, locks: {} };
  const queueFile: QueueFile = { version: 1, queue: [] };

  fs.writeFileSync(path.join(agentsDir, "status.json"), JSON.stringify(statusFile, null, 2));
  fs.writeFileSync(path.join(agentsDir, "locks.json"), JSON.stringify(locksFile, null, 2));
  fs.writeFileSync(path.join(agentsDir, "queue.json"), JSON.stringify(queueFile, null, 2));

  // Add .agents/ to .gitignore if it exists
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignoreEntry = ".agents/";
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf8");
    if (!content.includes(gitignoreEntry)) {
      fs.appendFileSync(gitignorePath, `\n# GSS — Git Shadow Session\n${gitignoreEntry}\n`);
      console.log(`Added ${gitignoreEntry} to .gitignore`);
    }
  } else {
    fs.writeFileSync(gitignorePath, `# GSS — Git Shadow Session\n${gitignoreEntry}\n`);
    console.log(`Created .gitignore with ${gitignoreEntry}`);
  }

  console.log(`GSS initialized at ${agentsDir}`);
  console.log();
  console.log("Usage:");
  console.log("  eval $(gss switch <branch>)   # switch session (eval for GIT_INDEX_FILE)");
  console.log("  gss lock <file>               # acquire exclusive file lock");
  console.log("  gss release <file>            # release file lock");
  console.log("  gss wait <file>               # wait until file is unlocked");
  console.log("  gss status                    # show all agents and locks");
}
