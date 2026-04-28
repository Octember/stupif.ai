import {
  countPromptTokens,
  findingsAuditRequest,
  runFindingsAudit,
} from "./analysis.ts";
import { enabledChecks } from "./checks.ts";
import { emptyContextPack, repomixContextPack } from "./repomix-provider.ts";
import type { LocalModel } from "./model.ts";
import type { Tracer } from "./trace.ts";
import { countTraceEvents } from "./trace.ts";
import type {
  AnalyzeCommand,
  AuditReviewResult,
  AuditReviewStats,
  Finding,
  FindingsResult,
  SemChangeSet,
  SemContext,
  TraceEvent,
} from "./types.ts";

export type FindingsAuditDeps = Readonly<{
  model: LocalModel;
  changeSet: SemChangeSet;
  checks: ReturnType<typeof enabledChecks>;
  command: AnalyzeCommand;
  t: Tracer;
  traceEvents: TraceEvent[];
}>;

/**
 * Sem-engine findings audit: packs context, runs the audit model, splits oversized batches.
 * Dependencies are injected once; recursive work is only `(batch, batchLabel)`.
 */
export class FindingsAuditSession {
  private readonly limiter: ConcurrencyLimiter;

  constructor(private readonly deps: FindingsAuditDeps) {
    this.limiter = new ConcurrencyLimiter(deps.command.auditConcurrency);
  }

  async runBatches(
    batches: readonly (readonly SemContext[])[],
  ): Promise<FindingsResult & { stats: AuditReviewStats; auditModelCalls: number }> {
    const findings: Finding[] = [];
    const stats = {
      totalTargets: 0,
      finding: 0,
      clean: 0,
      uncertain: 0,
      invalid: 0,
    };
    for (const [index, batch] of batches.entries()) {
      const result = await this.auditOneBatch(
        batch,
        `${index + 1}/${batches.length}`,
      );
      findings.push(...result.findings);
      stats.totalTargets += result.stats.totalTargets;
      stats.finding += result.stats.finding;
      stats.clean += result.stats.clean;
      stats.uncertain += result.stats.uncertain;
      stats.invalid += result.stats.invalid;
    }
    return {
      findings,
      summary: summarizeFindingsCount(findings.length),
      stats,
      auditModelCalls: countTraceEvents(this.deps.traceEvents, "audit.batch"),
    };
  }

  private async auditOneBatch(
    batch: readonly SemContext[],
    batchLabel: string,
  ): Promise<AuditReviewResult> {
    const { model, changeSet, checks, command, t, traceEvents } = this.deps;

    const { value: ctx } = await t.trace(
      "context.pack",
      async () => {
        const pack =
          command.auditContext === "none"
            ? emptyContextPack()
            : await repomixContextPack(changeSet.contextCwd, batch, changeSet.changes);
        const request = findingsAuditRequest(changeSet, batch, pack, checks, command.auditPrompt);
        const inputTokens = await countPromptTokens(model, request.prompt);
        return { pack, request, inputTokens };
      },
      {
        fields: { candidates: batch.length },
        count: (v) => v.pack.filePaths.length,
        detail: (v) =>
          `batch=${batchLabel} input_tokens=${v.inputTokens} pack_tokens=${v.pack.totalTokens} chars=${v.pack.totalCharacters}`,
      },
    );
    const { pack, request, inputTokens } = ctx;

    if (inputTokens > command.maxAuditInputTokens) {
      if (batch.length <= 1) {
        throw new Error(
          `Findings audit input has ${inputTokens} tokens, above max ${command.maxAuditInputTokens}.`,
        );
      }
      const splitAt = Math.ceil(batch.length / 2);
      pushTraceEvent(command, traceEvents, {
        name: "audit.split",
        ms: 0,
        count: batch.length,
        detail: `batch=${batchLabel} input_tokens=${inputTokens} max=${command.maxAuditInputTokens}`,
      });
      const [left, right] = await Promise.all([
        this.auditOneBatch(batch.slice(0, splitAt), `${batchLabel}.1`),
        this.auditOneBatch(batch.slice(splitAt), `${batchLabel}.2`),
      ]);
      return combineAuditResults(left, right);
    }

    const { value: result } = await t.trace(
      "audit.batch",
      () => this.limiter.run(() => runFindingsAudit(model, changeSet, batch, pack, checks, request)),
      {
        fields: { candidates: batch.length },
        count: (r) => r.findings.length,
        detail: (r) =>
          `batch=${batchLabel} candidates=${batch.length} input_tokens=${inputTokens} targets=${r.stats.totalTargets} clean=${r.stats.clean} uncertain=${r.stats.uncertain} invalid=${r.stats.invalid}`,
      },
    );
    return result;
  }
}

export function debugSemTrace(command: AnalyzeCommand, event: TraceEvent): void {
  if (!command.debugSem) return;
  const parts = [`trace ${event.name}`, `${event.ms}ms`];
  if (event.count !== undefined) parts.push(`count=${event.count}`);
  if (event.detail) parts.push(event.detail);
  console.error(parts.join(" "));
}

function pushTraceEvent(
  command: AnalyzeCommand,
  traceEvents: TraceEvent[],
  event: TraceEvent,
): void {
  traceEvents.push(event);
  debugSemTrace(command, event);
}

function combineAuditResults(left: AuditReviewResult, right: AuditReviewResult): AuditReviewResult {
  const findings = [...left.findings, ...right.findings];
  return {
    findings,
    summary: summarizeFindingsCount(findings.length),
    stats: {
      totalTargets: left.stats.totalTargets + right.stats.totalTargets,
      finding: left.stats.finding + right.stats.finding,
      clean: left.stats.clean + right.stats.clean,
      uncertain: left.stats.uncertain + right.stats.uncertain,
      invalid: left.stats.invalid + right.stats.invalid,
    },
  };
}

function summarizeFindingsCount(count: number): string {
  return count === 0
    ? "No clear judgment-offload signal found."
    : `${count} finding review${count === 1 ? "" : "s"} accepted.`;
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}
