#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  auditCandidates,
  auditSemContexts,
  scoutBatch,
  scoutSemChanges,
} from "./analysis.ts";
import { batchDiff } from "./batcher.ts";
import { candidateContexts } from "./candidate-context.ts";
import { enabledChecks } from "./checks.ts";
import { parseCommand } from "./command.ts";
import { MODEL_REGISTRY } from "./constants.ts";
import { readDiffFromStdin } from "./diff.ts";
import {
  netDiffForCommit,
  netDiffForRecentCommits,
  netDiffFromStdin,
  netDiffSince,
} from "./git.ts";
import {
  firstRunModelBootstrap,
  loadLocalModel,
  loadLocalModels,
  type LocalModel,
} from "./model.ts";
import { helpText, renderReport } from "./render.ts";
import { semChangeSetForCommand, semContexts } from "./sem-provider.ts";
import { createEventedTracer, trace, type SpanTraceEvent } from "./trace.ts";
import type {
  AnalysisReport,
  AnalyzeCommand,
  FindingsResult,
  NetDiff,
  SemCandidate,
  SemChangeSet,
  SemContext,
  SemTraceEvent,
} from "./types.ts";

const SEM_SCOUT_CHUNK_SIZE = 200;
const SEM_AUDIT_CHUNK_SIZE = 5;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  try {
    const command = parseCommand(argv);
    if (command.kind === "help") {
      console.log(helpText());
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
    async () => {
      const modelPath = await firstRunModelBootstrap(command.model);
      const scoutModel = await loadLocalModel(
        modelPath,
        command.model,
        "scout",
      );
      const auditModel = await loadLocalModel(
        modelPath,
        command.model,
        "audit",
      );
      return { scoutModel, auditModel };
    },
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
          {
            batch: batch.id,
          },
        );
        pointers.push(...candidates);
      }
      return pointers;
    },
  );

  const contexts = candidateContexts(batches, candidatePointers);
  const auditedContexts = contexts;
  const { value: result, ms: auditMs } = await trace.trace(
    "audit.candidates",
    () => auditCandidates(auditModel, diff, auditedContexts, checks),
    {
      candidates: auditedContexts.length,
    },
  );

  return {
    run: {
      mode: command.kind,
      engine: command.engine,
      modelId: command.model,
      checkIds: checks.map((check) => check.id),
      sourceId: diff.id,
      label: diff.label,
      stats: diff.stats,
      batchesScanned: batches.length,
      candidateCount: new Set(candidatePointers).size,
      entitiesScanned: 0,
      auditedCandidateCount: auditedContexts.length,
      scoutModelCalls: batches.length,
      auditModelCalls: auditedContexts.length > 0 ? 1 : 0,
      warnings: [],
      timingsMs: {
        diff: diffMs,
        modelLoad: modelMs,
        search: searchMs,
        audit: auditMs,
        total: Date.now() - startedAt,
      },
    },
    result,
  };
}

async function runSemEngine(
  command: AnalyzeCommand,
  checks: ReturnType<typeof enabledChecks>,
  startedAt: number,
): Promise<AnalysisReport> {
  const semTrace: SemTraceEvent[] = [];
  const sem = createEventedTracer({
    tracer: trace,
    onEvent: (event) => pushSemTrace(command, semTrace, event),
  });
  const { value: changeSet, ms: diffMs } = await sem.trace(
    "sem.diff",
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

  const { value: models, ms: modelMs } = await sem.trace(
    "model.load",
    async () => loadLocalModels(command.model),
    {
      count: () => 2,
      detail: () => "scout+audit",
    },
  );
  const { scoutModel, auditModel } = models;

  try {
    const candidateBatches = chunkSemChangeSet(changeSet);
    const { value: candidates, ms: searchMs } = await sem.trace(
      "sem.scout.total",
      async () =>
        candidateBatches.length === 0
          ? []
          : scoutSemBatches(
              scoutModel,
              candidateBatches,
              checks,
              command,
              semTrace,
            ),
      {
        count: (v) => v.length,
        detail: () => `${candidateBatches.length} batches`,
      },
    );

    const { value: contexts, ms: contextMs } = await sem.trace(
      "sem.context",
      async () =>
        semContexts(
          changeSet.contextCwd,
          candidates.map((candidate) => candidate.entityId),
          changeSet.changes,
          command.debugSem,
        ),
      {
        fields: { candidates: candidates.length },
        count: (v) => v.length,
      },
    );

    const auditBatches = chunkSemContexts(contexts);
    const { value: result, ms: auditMs } = await sem.trace(
      "sem.audit.total",
      () =>
        auditSemContextBatches(
          auditModel,
          changeSet,
          auditBatches,
          checks,
          semTrace,
          command,
        ),
      {
        count: (v) => v.findings.length,
        detail: () => `${auditBatches.length} batches`,
      },
    );

    const run = buildSemRun({
      command,
      checks,
      changeSet,
      startedAt,
      candidateBatchesCount: candidateBatches.length,
      candidatesCount: candidates.length,
      auditedCandidateCount: contexts.length,
      auditBatchesCount: auditBatches.length,
      timings: {
        diffMs,
        modelMs,
        searchMs,
        auditMs: auditMs + contextMs,
      },
      semTrace,
    });

    return { run, result };
  } finally {
    await changeSet.cleanup();
  }
}

function buildSemRun(args: Readonly<{
  command: AnalyzeCommand;
  checks: ReturnType<typeof enabledChecks>;
  changeSet: SemChangeSet;
  startedAt: number;
  candidateBatchesCount: number;
  candidatesCount: number;
  auditedCandidateCount: number;
  auditBatchesCount: number;
  timings: Readonly<{
    diffMs: number;
    modelMs: number;
    searchMs: number;
    auditMs: number;
  }>;
  semTrace: readonly SemTraceEvent[];
}>): AnalysisReport["run"] {
  return {
    mode: args.command.kind,
    engine: args.command.engine,
    modelId: args.command.model,
    checkIds: args.checks.map((check) => check.id),
    sourceId: args.changeSet.id,
    label: args.changeSet.label,
    stats: {
      filesChanged: args.changeSet.summary.fileCount,
      additions: args.changeSet.summary.added,
      deletions: args.changeSet.summary.deleted,
    },
    batchesScanned: 0,
    entitiesScanned: args.changeSet.summary.total,
    candidateCount: args.candidatesCount,
    auditedCandidateCount: args.auditedCandidateCount,
    scoutModelCalls: args.candidateBatchesCount,
    auditModelCalls: args.auditBatchesCount,
    warnings: [],
    timingsMs: {
      diff: args.timings.diffMs,
      modelLoad: args.timings.modelMs,
      search: args.timings.searchMs,
      audit: args.timings.auditMs,
      total: Date.now() - args.startedAt,
    },
    semTrace: args.semTrace,
  };
}

async function auditSemContextBatches(
  model: LocalModel,
  changeSet: SemChangeSet,
  batches: readonly (readonly SemContext[])[],
  checks: ReturnType<typeof enabledChecks>,
  semTrace: SemTraceEvent[],
  command: AnalyzeCommand,
): Promise<FindingsResult> {
  const findings = [];
  const summaries = [];
  for (const [index, batch] of batches.entries()) {
    const { value: result, ms } = await trace.trace(
      "audit.sem",
      () => auditSemContexts(model, changeSet, batch, checks),
      { candidates: batch.length },
    );
    semTrace.push({
      name: "sem.audit.batch",
      ms,
      count: result.findings.length,
      detail: `batch=${index + 1}/${batches.length} candidates=${batch.length}`,
    });
    debugSemTrace(command, semTrace[semTrace.length - 1]);
    findings.push(...result.findings);
    if (result.summary) summaries.push(result.summary);
  }
  return {
    findings,
    summary:
      findings.length === 0
        ? "No clear judgment-offload signal found."
        : summaries.join(" "),
  };
}

async function scoutSemBatches(
  model: LocalModel,
  batches: readonly SemChangeSet[],
  checks: ReturnType<typeof enabledChecks>,
  command: AnalyzeCommand,
  semTrace: SemTraceEvent[],
): Promise<readonly SemCandidate[]> {
  const candidates: SemCandidate[] = [];
  const seen = new Set<string>();
  for (const [index, batch] of batches.entries()) {
    if (candidates.length >= command.maxCandidates) break;
    const remaining: number = command.maxCandidates - candidates.length;
    const { value: batchCandidates, ms } = await trace.trace(
      "search.sem",
      () => scoutSemChanges(model, batch, checks, remaining),
      { entities: batch.changes.length },
    );
    semTrace.push({
      name: "sem.scout.batch",
      ms,
      count: batchCandidates.length,
      detail: `batch=${index + 1}/${batches.length} entities=${batch.changes.length} remaining=${remaining}`,
    });
    debugSemTrace(command, semTrace[semTrace.length - 1]);
    for (const candidate of batchCandidates) {
      if (seen.has(candidate.entityId)) continue;
      seen.add(candidate.entityId);
      candidates.push(candidate);
      if (candidates.length >= command.maxCandidates) break;
    }
  }
  return candidates;
}

function pushSemTrace(
  command: AnalyzeCommand,
  semTrace: SemTraceEvent[],
  event: SpanTraceEvent,
): void {
  semTrace.push(event);
  debugSemTrace(command, event);
}

function debugSemTrace(command: AnalyzeCommand, event: SemTraceEvent): void {
  if (!command.debugSem) return;
  const parts = [`trace ${event.name}`, `${event.ms}ms`];
  if (event.count !== undefined) parts.push(`count=${event.count}`);
  if (event.detail) parts.push(event.detail);
  console.error(parts.join(" "));
}

function chunkSemChangeSet(changeSet: SemChangeSet): readonly SemChangeSet[] {
  const chunks: SemChangeSet[] = [];
  for (
    let index = 0;
    index < changeSet.changes.length;
    index += SEM_SCOUT_CHUNK_SIZE
  ) {
    const changes = changeSet.changes.slice(
      index,
      index + SEM_SCOUT_CHUNK_SIZE,
    );
    chunks.push({
      ...changeSet,
      label: `${changeSet.label} batch ${chunks.length + 1}`,
      changes,
      summary: {
        ...changeSet.summary,
        fileCount: new Set(changes.map((change) => change.filePath)).size,
        total: changes.length,
      },
    });
  }
  return chunks;
}

function chunkSemContexts(
  contexts: readonly SemContext[],
): readonly (readonly SemContext[])[] {
  const chunks: SemContext[][] = [];
  for (let index = 0; index < contexts.length; index += SEM_AUDIT_CHUNK_SIZE) {
    chunks.push(contexts.slice(index, index + SEM_AUDIT_CHUNK_SIZE));
  }
  return chunks;
}

function printRunPlan(
  command: AnalyzeCommand,
  diff: NetDiff,
  checkIds: readonly string[],
): void {
  if (command.json) return;
  console.error("🧙 stupify 🪄");
  console.error(`Window: ${diff.label}`);
  console.error(
    `Diff: ${diff.stats.filesChanged} files changed, ${diff.stats.additions} added, ${diff.stats.deletions} deleted`,
  );
  console.error(`Model: ${MODEL_REGISTRY[command.model].name}`);
  console.error(`Checks: ${checkIds.join(", ")}`);
}

function printSemRunPlan(
  command: AnalyzeCommand,
  changeSet: SemChangeSet,
  checkIds: readonly string[],
): void {
  if (command.json) return;
  console.error("🧙 stupify 🪄");
  console.error(`Window: ${changeSet.label}`);
  console.error(
    `Sem: ${changeSet.summary.fileCount} files, ${changeSet.summary.total} changed entities`,
  );
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
