import { execSync, ExecSyncOptions } from "child_process";
import { existsSync, copyFileSync } from "fs";

function run(cmd: string, opts?: ExecSyncOptions): string {
  return (execSync(cmd, { encoding: "utf8", ...opts }) as string).trim();
}

export function getProjectRoot(): string {
  try {
    return run("git rev-parse --show-toplevel");
  } catch {
    throw new Error("Not inside a git repository.");
  }
}

export function getCurrentBranch(): string {
  const branch = run("git branch --show-current");
  if (!branch) throw new Error("HEAD is detached. Cannot determine current branch.");
  return branch;
}

export function branchExists(branch: string): boolean {
  try {
    run(`git rev-parse --verify "refs/heads/${branch}"`);
    return true;
  } catch {
    return false;
  }
}

export function hasUncommittedChanges(): boolean {
  return run("git status --porcelain") !== "";
}

/** Encodes branch name for use in stash messages (/ → %2F) */
export function encodeBranchName(branch: string): string {
  return branch.replace(/\//g, "%2F");
}

export function decodeBranchName(encoded: string): string {
  return encoded.replace(/%2F/g, "/");
}

export function stashSessionName(branch: string): string {
  return `gss/session-${encodeBranchName(branch)}`;
}

export function stashPush(branch: string): void {
  const message = stashSessionName(branch);
  run(`git stash push -m "${message}"`);
}

export function findSessionStash(branch: string): string | null {
  const target = stashSessionName(branch);
  let lines: string;
  try {
    lines = run("git stash list --format=%gd:%gs");
  } catch {
    return null;
  }

  for (const line of lines.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const ref = line.slice(0, colonIdx);
    const msg = line.slice(colonIdx + 1);
    if (msg.includes(target)) {
      return ref;
    }
  }
  return null;
}

export function stashPop(ref: string): { success: boolean; stderr: string } {
  try {
    run(`git stash pop ${ref}`);
    return { success: true, stderr: "" };
  } catch (e: unknown) {
    const stderr = e instanceof Error ? e.message : String(e);
    return { success: false, stderr };
  }
}

export function checkout(branch: string): void {
  try {
    run(`git checkout "${branch}"`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`git checkout failed: ${msg}`);
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }

}

export function getProcessStartTime(pid: number): string | null {
  try {
    return run(`ps -o lstart= -p ${pid}`).trim();
  } catch {
    return null;
  }
}

export function shadowIndexExists(indexPath: string): boolean {
  return existsSync(indexPath);
}

export function copyShadowIndexSync(src: string, dst: string): boolean {
  try {
    if (!existsSync(src)) return false;
    copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

export { run as gitRaw };
