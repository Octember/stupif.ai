#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { auditCandidates, scoutBatch, scoutSemChanges } from "./analysis.ts";
import { batchDiff } from "./batcher.ts";
import { candidateContexts } from "./candidate-context.ts";
import { enabledChecks } from "./checks.ts";
import { parseCommand } from "./command.ts";
import { MODEL_REGISTRY } from "./constants.ts";
import { counterScoutTargets } from "./counter-scout.ts";
import { readDiffFromStdin } from "./diff.ts";
import { runExperiment } from "./experiment.ts";
import {
  netDiffForCommit,
  netDiffForRecentCommits,
  netDiffFromStdin,
  netDiffSince,
} from "./git.ts";
import { loadLocalModels, type LocalModel } from "./model.ts";
import { entityContextsFromChanges } from "./repomix-provider.ts";
import { helpText, renderReport } from "./render.ts";
import { FindingsAuditSession, debugSemTrace } from "./sem-findings-audit.ts";
import { semChangeSetForCommand } from "./sem-provider.ts";
import { countTraceEvents, createTracer, trace } from "./trace.ts";
import type {
  AnalysisReport,
  AnalyzeCommand,
  DebugTarget,
  NetDiff,
  SemCandidate,
  SemChangeSet,
  SemContext,
  TraceEvent,
} from "./types.ts";

const SEM_SCOUT_CHUNK_SIZE = 200;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  try {
    const command = parseCommand(argv);
    if (command.kind === "help") {
      console.log(helpText());
      return 0;
    }
    if (command.kind === "experiment") {
      const outputDir = await runExperiment(command.configPath);
      console.log(`Experiment results written to ${outputDir}`);
      return 0;
    }

    const checks = enabledChecks(command.checkIds);
    const report =
      command.engine === "sem"
        ? await runSemEngine(command, checks, startedAt)
        : await runRawDiffEngine(command, checks, startedAt);

    console.log(renderReport(report, command));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runRawDiffEngine(
  command: AnalyzeCommand,
  checks: ReturnType<typeof enabledChecks>,
  startedAt: number,
): Promise<AnalysisReport> {
  const { value: diff, ms: diffMs } = await trace.trace("net.diff", () =>
    netDiffForCommand(command),
  );

  printRunPlan(
    command,
    diff,
    checks.map((check) => check.id),
  );

  const { value: models, ms: modelMs } = await trace.trace(
    "model.load",
    () => loadLocalModels(command.model),
  );
  const { scoutModel, auditModel } = models;

  const batches = batchDiff(diff.text);
  const { value: candidatePointers, ms: searchMs } = await trace.trace(
    "search.total",
    async () => {
      const pointers: string[] = [];
      for (const batch of batches) {
        const { value: candidates } = await trace.trace(
          "search.batch",
          () => scoutBatch(scoutModel, batch, checks, diff.label),
          { fields: { batch: batch.id } },
        );
        pointers.push(...candidates);
      }
      return pointers;
    },
  );

  const contexts = candidateContexts(batches, candidatePointers);
  const { value: result, ms: auditMs } = await trace.trace(
    "audit.candidates",
    () => auditCandidates(auditModel, diff, contexts, checks),
    { fields: { candidates: contexts.length } },
  );

  return {
    run: {
      mode: command.kind,
      engine: command.engine,
      auditContext: command.auditContext,
      auditPrompt: command.auditPrompt,
      modelId: command.model,
      checkIds: checks.map((check) => check.id),
      sourceId: diff.id,
      label: diff.label,
      stats: diff.stats,
      batchesScanned: batches.length,
      candidateCount: new Set(candidatePointers).size,
      entitiesScanned: 0,
      auditedCandidateCount: contexts.length,
      scoutModelCalls: batches.length,
      auditModelCalls: contexts.length > 0 ? 1 : 0,
      warnings: [],
      timingsMs: {
        diff: diffMs,
        modelLoad: modelMs,
        search: searchMs,
        audit: auditMs,
        total: Date.now() - startedAt,
      },
      debugTargets: command.debugTargets ? [] : undefined,
    },
    result,
  };
}

async function runSemEngine(
  command: AnalyzeCommand,
  checks: ReturnType<typeof enabledChecks>,
  startedAt: number,
): Promise<AnalysisReport> {
  const traceEvents: TraceEvent[] = [];
  const t = createTracer({
    onEvent: (event) => {
      traceEvents.push(event);
      debugSemTrace(command, event);
    },
  });

  const { value: changeSet, ms: diffMs } = await t.trace(
    "entity.diff",
    () => semChangeSetForCommand(command),
    {
      count: (v) => v.summary.total,
      detail: (v) => `${v.summary.fileCount} files`,
    },
  );

  printSemRunPlan(
    command,
    changeSet,
    checks.map((check) => check.id),
  );

  const { value: models, ms: modelMs } = await t.trace(
    "model.load",
    () => loadLocalModels(command.model),
    {
      count: () => 2,
      detail: () => "scout+audit",
    },
  );
  const { scoutModel, auditModel } = models;

  try {
    const candidateBatches = chunkSemChangeSet(changeSet);
    const { value: candidates, ms: searchMs } = await t.trace(
      "scout.total",
      async () =>
        candidateBatches.length === 0
          ? []
          : command.scout === "counter"
            ? counterScoutTargets(changeSet, checks, command.maxCandidates)
            : scoutSemBatches(
                scoutModel,
                candidateBatches,
                checks,
                command,
                t,
              ),
      {
        count: (v) => v.length,
        detail: () => `${command.scout} scout ${candidateBatches.length} batches`,
      },
    );

    const { value: contexts, ms: contextMs } = await t.trace(
      "context.select",
      async () => entityContextsFromChanges(candidates, changeSet.changes),
      {
        fields: { candidates: candidates.length },
        count: (v) => v.length,
        detail: (v) => `${new Set(v.map((context) => context.filePath).filter(Boolean)).size} files`,
      },
    );

    const auditBatches = chunkSemContexts(contexts, command.auditBatchSize);
    const findingsAudit = new FindingsAuditSession({
      model: auditModel,
      changeSet,
      checks,
      command,
      t,
      traceEvents,
    });
    const { value: result, ms: auditMs } = await t.trace(
      "audit.total",
      () => findingsAudit.runBatches(auditBatches),
      {
        count: (v) => v.findings.length,
        detail: (v) =>
          `${auditBatches.length} batches targets=${v.stats.totalTargets} clean=${v.stats.clean} uncertain=${v.stats.uncertain} invalid=${v.stats.invalid}`,
      },
    );

    return {
      run: {
        mode: command.kind,
        engine: command.engine,
        auditContext: command.auditContext,
        auditPrompt: command.auditPrompt,
        modelId: command.model,
        checkIds: checks.map((check) => check.id),
        sourceId: changeSet.id,
        label: changeSet.label,
        stats: {
          filesChanged: changeSet.summary.fileCount,
          additions: changeSet.summary.added,
          deletions: changeSet.summary.deleted,
        },
        batchesScanned: 0,
        entitiesScanned: changeSet.summary.total,
        candidateCount: candidates.length,
        targetsByCheck: countTargetsByCheck(candidates),
        auditedCandidateCount: contexts.length,
        scoutModelCalls: countTraceEvents(traceEvents, "scout.batch"),
        auditModelCalls: result.auditModelCalls,
        timingsMs: {
          diff: diffMs,
          modelLoad: modelMs,
          search: searchMs,
          audit: auditMs + contextMs,
          total: Date.now() - startedAt,
        },
        warnings: [],
        auditStats: result.stats,
        debugTargets: command.debugTargets ? debugTargetsFromContexts(contexts, changeSet.label) : undefined,
        traceEvents,
      },
      result,
    };
  } finally {
    await changeSet.cleanup();
  }
}

function countTargetsByCheck(candidates: readonly SemCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    counts[candidate.checkId] = (counts[candidate.checkId] ?? 0) + 1;
  }
  return counts;
}

function debugTargetsFromContexts(
  contexts: readonly SemContext[],
  sourceLabel: string,
): readonly DebugTarget[] {
  return contexts.map((context) => ({
    targetId: context.targetId,
    checkId: context.checkId,
    entityId: context.entityId,
    entityKind: context.entityKind,
    changeKind: context.changeKind,
    scoutReason: context.reason,
    sourceLabel,
  }));
}

async function scoutSemBatches(
  model: LocalModel,
  batches: readonly SemChangeSet[],
  checks: ReturnType<typeof enabledChecks>,
  command: AnalyzeCommand,
  t: ReturnType<typeof createTracer>,
): Promise<readonly SemCandidate[]> {
  const candidates: SemCandidate[] = [];
  const seen = new Set<string>();
  const targetsByCheck = new Map<string, number>();
  const maxTargetsPerCheck = 6;
  for (const [index, batch] of batches.entries()) {
    if (candidates.length >= command.maxCandidates) break;
    const remaining: number = command.maxCandidates - candidates.length;
    const { value: batchCandidates } = await t.trace(
      "scout.batch",
      async () => scoutSemChanges(model, batch, checks, remaining),
      {
        fields: { entities: batch.changes.length },
        count: (v) => v.length,
        detail: (v) =>
          `batch=${index + 1}/${batches.length} entities=${batch.changes.length} remaining=${remaining}`,
      },
    );
    for (const candidate of batchCandidates) {
      const key = `${candidate.entityId}\u0000${candidate.checkId}`;
      if (seen.has(key)) continue;
      const checkCount = targetsByCheck.get(candidate.checkId) ?? 0;
      if (checkCount >= maxTargetsPerCheck) continue;
      seen.add(key);
      targetsByCheck.set(candidate.checkId, checkCount + 1);
      candidates.push({
        ...candidate,
        targetId: `t${String(candidates.length + 1).padStart(3, "0")}`,
      });
      if (candidates.length >= command.maxCandidates) break;
    }
  }
  return candidates;
}

function chunkBySize<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size) as T[]);
  }
  return chunks;
}

function chunkSemChangeSet(changeSet: SemChangeSet): readonly SemChangeSet[] {
  return chunkBySize(changeSet.changes, SEM_SCOUT_CHUNK_SIZE).map((changes, index) => ({
    ...changeSet,
    label: `${changeSet.label} batch ${index + 1}`,
    changes,
    summary: {
      ...changeSet.summary,
      fileCount: new Set(changes.map((change) => change.filePath)).size,
      total: changes.length,
    },
  }));
}

function chunkSemContexts(
  contexts: readonly SemContext[],
  chunkSize: number,
): readonly (readonly SemContext[])[] {
  return chunkBySize(contexts, chunkSize);
}

function printRunPlan(
  command: AnalyzeCommand,
  diff: NetDiff,
  checkIds: readonly string[],
): void {
  printRunPlanShared(
    command,
    diff.label,
    `Diff: ${diff.stats.filesChanged} files changed, ${diff.stats.additions} added, ${diff.stats.deletions} deleted`,
    checkIds,
  );
}

function printSemRunPlan(
  command: AnalyzeCommand,
  changeSet: SemChangeSet,
  checkIds: readonly string[],
): void {
  printRunPlanShared(
    command,
    changeSet.label,
    `Sem: ${changeSet.summary.fileCount} files, ${changeSet.summary.total} changed entities`,
    checkIds,
  );
}

function printRunPlanShared(
  command: AnalyzeCommand,
  windowLabel: string,
  detailLine: string,
  checkIds: readonly string[],
): void {
  if (command.json) return;
  console.error("🧙 stupify 🪄");
  console.error(`Window: ${windowLabel}`);
  console.error(detailLine);
  console.error(`Model: ${MODEL_REGISTRY[command.model].name}`);
  console.error(`Checks: ${checkIds.join(", ")}`);
}

async function netDiffForCommand(command: AnalyzeCommand): Promise<NetDiff> {
  if (command.kind === "since") return netDiffSince(command.since);
  if (command.kind === "stdin")
    return netDiffFromStdin(await readDiffFromStdin());
  if (command.kind === "commit") return netDiffForCommit(command.commit);
  return netDiffForRecentCommits(command.count);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
