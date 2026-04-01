#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runSwitch } from "./commands/switch.js";
import { runLock } from "./commands/lock.js";
import { runRelease } from "./commands/release.js";
import { runWait } from "./commands/wait.js";
import { runStatus } from "./commands/status.js";

const program = new Command();

program
  .name("gss")
  .description("Git Shadow Session — multi-agent parallel branch development")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize GSS in the current git repository")
  .action(() => {
    try {
      runInit();
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("switch <branch>")
  .description(
    "Switch to a branch session (stash current changes, checkout, restore session stash).\n" +
      "IMPORTANT: Use with eval to propagate GIT_INDEX_FILE:\n" +
      "  eval $(gss switch <branch>)"
  )
  .action(async (branch: string) => {
    try {
      await runSwitch(branch);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("lock <file>")
  .description("Acquire an exclusive lock on a file")
  .action(async (file: string) => {
    try {
      await runLock(file);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("release <file>")
  .description("Release the lock on a file")
  .action(async (file: string) => {
    try {
      await runRelease(file);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("wait <file>")
  .description("Wait until a file lock is available, then acquire it")
  .option("-t, --timeout <seconds>", "Timeout in seconds (default: 60)", "60")
  .action(async (file: string, opts: { timeout: string }) => {
    const timeoutMs = parseInt(opts.timeout, 10) * 1000;
    try {
      await runWait(file, timeoutMs);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show all active agents, their branches, and locked files")
  .action(() => {
    try {
      runStatus();
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
