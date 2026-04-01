export interface AgentStatus {
  pid: number;
  branch: string;
  lockedFiles: string[]; // absolute paths
  startedAt: string; // ISO 8601
  lastSeen: string; // ISO 8601 — heartbeat
  hasConflict?: boolean; // set true when stash pop has conflicts
}

export type StatusMap = Record<string, AgentStatus>;

export interface LockEntry {
  agentId: string;
  pid: number;
  branch: string;
  timestamp: string; // ISO 8601
}

export type LocksMap = Record<string, LockEntry>;

export interface QueueEntry {
  agentId: string;
  pid: number;
  branch: string;
  filePath: string; // absolute path
  requestedAt: string; // ISO 8601
}

export interface StatusFile {
  version: 1;
  agents: StatusMap;
}

export interface LocksFile {
  version: 1;
  locks: LocksMap;
}

export interface QueueFile {
  version: 1;
  queue: QueueEntry[];
}

export interface MutexFile {
  pid: number;
  ts: number; // Date.now()
}

export interface GssConfig {
  agentsDir: string; // absolute path to .agents/
  projectRoot: string; // git rev-parse --show-toplevel
}
