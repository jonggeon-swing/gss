#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runSwitch } from "./commands/switch.js";
import { runLock } from "./commands/lock.js";
import { runRelease } from "./commands/release.js";
import { runWait } from "./commands/wait.js";
import { runStatus } from "./commands/status.js";
import { runConfig } from "./commands/config.js";

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
      "Run 'gss config --install' once to enable shell integration — then just: gss switch <branch>"
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

program
  .command("config")
  .description(
    "Generate or install shell integration for safe GIT_INDEX_FILE propagation.\n" +
      "Replaces the insecure 'eval $(gss switch ...)' pattern.\n\n" +
      "Examples:\n" +
      "  gss config                     # print snippet (auto-detect shell)\n" +
      "  gss config --shell zsh         # print snippet for zsh\n" +
      "  gss config --install           # append to ~/.zshrc (or shell config)\n" +
      "  gss config --shell bash --install"
  )
  .option("-s, --shell <shell>", "Target shell: zsh | bash | fish")
  .option("--install", "Append the integration snippet to your shell config file")
  .action((opts: { shell?: string; install?: boolean }) => {
    try {
      runConfig(opts);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
