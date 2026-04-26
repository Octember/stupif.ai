#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { analyzeDiff } from "./analysis.js";
import { enabledChecks } from "./checks.js";
import { parseCommand } from "./command.js";
import { readDiffFromStdin } from "./diff.js";
import { readDiffForCommit } from "./git.js";
import { firstRunModelBootstrap, loadLocalModel } from "./model.js";
import { helpText, renderFindings } from "./render.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  try {
    const command = parseCommand(argv);
    if (command.kind === "help") {
      console.log(helpText());
      return 0;
    }

    const checks = enabledChecks(command.checkIds);
    const diffStartedAt = Date.now();
    const diff =
      command.kind === "commit"
        ? await readDiffForCommit(command.commit)
        : await readDiffFromStdin();
    const diffMs = Date.now() - diffStartedAt;

    const modelStartedAt = Date.now();
    const modelPath = await firstRunModelBootstrap();
    const model = await loadLocalModel(modelPath);
    const modelMs = Date.now() - modelStartedAt;

    const promptStartedAt = Date.now();
    const result = await analyzeDiff(model, diff, checks);
    const promptMs = Date.now() - promptStartedAt;

    console.log(renderFindings(result, command));
    console.error(
      `Timing: total_ms=${Date.now() - startedAt} diff_ms=${diffMs} model_ms=${modelMs} prompt_ms=${promptMs} diff_bytes=${Buffer.byteLength(diff.text, "utf8")} commit_message_bytes=${Buffer.byteLength(diff.commitMessage ?? "", "utf8")} hunks=${diff.hunkCount} checks=${checks.length}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
