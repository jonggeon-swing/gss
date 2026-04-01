/**
 * Agent identity for the current terminal session.
 *
 * Priority:
 *   1. GSS_AGENT_ID env var (explicit override — useful for named agents)
 *   2. process.ppid — parent shell PID, stable across multiple gss invocations
 *      in the same terminal session
 *
 * Usage: eval $(gss switch <branch>) sets GSS_AGENT_ID in the shell environment
 * if the user wants a named agent instead of PID-based identity.
 */
export function getAgentId(): string {
  if (process.env["GSS_AGENT_ID"]) {
    return process.env["GSS_AGENT_ID"];
  }
  return `agent-${process.ppid}`;
}
