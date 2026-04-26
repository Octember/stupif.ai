#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { analyzeBatch } from "./analysis.js";
import { createModelBatches } from "./batch.js";
import { enabledChecks } from "./checks.js";
import { parseCommand } from "./command.js";
import { MODEL_REGISTRY } from "./constants.js";
import { readDiffFromStdin } from "./diff.js";
import { readUnitForCommit, readUnitsForRecentCommits, unitFromStdinDiff } from "./git.js";
import { firstRunModelBootstrap, loadLocalModel } from "./model.js";
import { helpText, renderFindings } from "./render.js";
import { trace } from "./trace.js";
import type { AnalyzeCommand, DiffUnit, FindingsResult, ModelBatch, StupifyCheck } from "./types.js";

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
    const units = await trace.trace("diff.readUnits", () => readUnits(command));
    const batches = trace.traceSync("diff.batch", () => createModelBatches(units), {
      units: units.length,
      checks: checks.length,
    });
    const diffMs = Date.now() - diffStartedAt;
    printRunPlan(command, units, batches);

    const modelStartedAt = Date.now();
    const { modelPath, model } = await trace.trace("model.load", async () => {
      const modelPath = await firstRunModelBootstrap(command.model);
      const model = await loadLocalModel(modelPath, MODEL_REGISTRY[command.model].name);
      return { modelPath, model };
    });
    const modelMs = Date.now() - modelStartedAt;

    const promptStartedAt = Date.now();
    const result = await trace.trace(
      "analyze.batches",
      async () => mergeResults(await analyzeBatches(model, batches, checks)),
      { batches: batches.length, units: units.length, checks: checks.length, modelPath },
    );
    const promptMs = Date.now() - promptStartedAt;

    console.log(renderFindings(result, command));
    console.error(
      `Timing: total_ms=${Date.now() - startedAt} diff_ms=${diffMs} model_ms=${modelMs} prompt_ms=${promptMs} sources=${units.length} model_calls=${batches.length} checks=${checks.length} model=${command.model}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printRunPlan(command: AnalyzeCommand, units: readonly DiffUnit[], batches: readonly ModelBatch[]): void {
  console.error("🧙 stupify 🪄");
  console.error(`Loading local model: ${MODEL_REGISTRY[command.model].name}`);
  if (command.kind === "commits") {
    console.error(`Analyzing ${units.length} commits in one local process.`);
  } else if (command.kind === "commit") {
    console.error(`Analyzing commit ${command.commit} in one local process.`);
  } else {
    console.error("Analyzing stdin diff in one local process.");
  }
  console.error(`Model calls: ${batches.length}.`);
  if (batches.length > 1 || units.length > 1) console.error("This may take a minute...");
}

async function readUnits(command: AnalyzeCommand): Promise<readonly DiffUnit[]> {
  if (command.kind === "commit") return [await readUnitForCommit(command.commit)];
  if (command.kind === "commits") return readUnitsForRecentCommits(command.count);

  const diff = await readDiffFromStdin();
  return [unitFromStdinDiff(diff.text)];
}

function mergeResults(results: readonly FindingsResult[]): FindingsResult {
  return { findings: results.flatMap((result) => result.findings) };
}

async function analyzeBatches(
  model: Parameters<typeof analyzeBatch>[0],
  batches: readonly ModelBatch[],
  checks: readonly StupifyCheck[],
): Promise<readonly FindingsResult[]> {
  const results: FindingsResult[] = [];
  for (const batch of batches) results.push(await analyzeBatch(model, batch, checks));
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
