import fs from "fs";
import path from "path";
import { StatusFile, StatusMap, AgentStatus } from "../types/index.js";

function getStatusPath(agentsDir: string): string {
  return path.join(agentsDir, "status.json");
}

function readStatusFile(agentsDir: string): StatusFile {
  const p = getStatusPath(agentsDir);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as StatusFile;
  } catch {
    return { version: 1, agents: {} };
  }
}

function writeStatusFile(agentsDir: string, data: StatusFile): void {
  const p = getStatusPath(agentsDir);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export function registerAgent(
  agentsDir: string,
  agentId: string,
  branch: string
): void {
  const data = readStatusFile(agentsDir);
  const now = new Date().toISOString();
  const existing = data.agents[agentId];

  // Store parent shell PID — stable across multiple gss invocations in the same terminal
  data.agents[agentId] = {
    pid: process.ppid,
    branch,
    lockedFiles: existing?.lockedFiles ?? [],
    startedAt: existing?.startedAt ?? now,
    lastSeen: now,
    hasConflict: existing?.hasConflict,
  };

  writeStatusFile(agentsDir, data);
}

export function updateAgentBranch(
  agentsDir: string,
  agentId: string,
  branch: string
): void {
  const data = readStatusFile(agentsDir);
  const now = new Date().toISOString();

  if (!data.agents[agentId]) {
    data.agents[agentId] = {
      pid: process.ppid,
      branch,
      lockedFiles: [],
      startedAt: now,
      lastSeen: now,
    };
  } else {
    data.agents[agentId].branch = branch;
    data.agents[agentId].lastSeen = now;
  }

  writeStatusFile(agentsDir, data);
}

export function touchAgent(agentsDir: string, agentId: string): void {
  const data = readStatusFile(agentsDir);
  if (data.agents[agentId]) {
    data.agents[agentId].lastSeen = new Date().toISOString();
    writeStatusFile(agentsDir, data);
  }
}

export function addLockedFile(
  agentsDir: string,
  agentId: string,
  filePath: string
): void {
  const data = readStatusFile(agentsDir);
  if (!data.agents[agentId]) return;
  if (!data.agents[agentId].lockedFiles.includes(filePath)) {
    data.agents[agentId].lockedFiles.push(filePath);
    data.agents[agentId].lastSeen = new Date().toISOString();
    writeStatusFile(agentsDir, data);
  }
}

export function removeLockedFile(
  agentsDir: string,
  agentId: string,
  filePath: string
): void {
  const data = readStatusFile(agentsDir);
  if (!data.agents[agentId]) return;
  data.agents[agentId].lockedFiles = data.agents[agentId].lockedFiles.filter(
    (f) => f !== filePath
  );
  data.agents[agentId].lastSeen = new Date().toISOString();
  writeStatusFile(agentsDir, data);
}

export function setConflict(
  agentsDir: string,
  agentId: string,
  hasConflict: boolean
): void {
  const data = readStatusFile(agentsDir);
  if (!data.agents[agentId]) return;
  data.agents[agentId].hasConflict = hasConflict;
  writeStatusFile(agentsDir, data);
}

export function unregisterAgent(agentsDir: string, agentId: string): void {
  const data = readStatusFile(agentsDir);
  delete data.agents[agentId];
  writeStatusFile(agentsDir, data);
}

export function readStatus(agentsDir: string): StatusMap {
  return readStatusFile(agentsDir).agents;
}
