import { performance } from "node:perf_hooks";

export type TraceFields = Record<string, string | number | boolean | null | undefined>;

export type Tracer = {
  trace<T>(span: string, fn: () => Promise<T>, fields?: TraceFields): Promise<{ value: T; ms: number }>;
  trace<T>(span: string, fn: () => T, fields?: TraceFields): { value: T; ms: number };
};

export type SpanTraceEvent = Readonly<{
  name: string;
  ms: number;
  count?: number;
  detail?: string;
}>;

export type SpanTraceOptions<T> = Readonly<{
  fields?: TraceFields;
  count?: (value: T) => number;
  detail?: (value: T) => string;
}>;

export function createEventedTracer(args: Readonly<{
  tracer: Tracer;
  onEvent: (event: SpanTraceEvent) => void;
}>) {
  return {
    trace: async <T>(
      span: string,
      fn: () => Promise<T>,
      options?: SpanTraceOptions<T>,
    ): Promise<{ value: T; ms: number }> => {
      const result = await args.tracer.trace(span, fn, options?.fields);
      args.onEvent({
        name: span,
        ms: result.ms,
        count: options?.count?.(result.value),
        detail: options?.detail?.(result.value),
      });
      return result;
    },
  };
}

export type CreateTracerOptions = {
  enabled?: boolean;
  writeLine?: (line: string) => void;
};

export function createTracer(options?: CreateTracerOptions): Tracer {
  const enabled = options?.enabled ?? true;
  const writeLine = options?.writeLine ?? ((line) => process.stderr.write(line + "\n"));
  const nowMs = () => performance.now();

  function emit(span: string, durationMs: number, fields?: TraceFields) {
    if (!enabled) return;
    const payload: Record<string, unknown> = { span, ms: Math.round(durationMs) };
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v !== undefined) payload[k] = v;
    }
    writeLine(`trace ${JSON.stringify(payload)}`);
  }

  function trace<T>(
    span: string,
    fn: () => Promise<T>,
    fields?: TraceFields,
  ): Promise<{ value: T; ms: number }>;
  function trace<T>(span: string, fn: () => T, fields?: TraceFields): { value: T; ms: number };
  function trace<T>(
    span: string,
    fn: (() => T) | (() => Promise<T>),
    fields?: TraceFields,
  ): Promise<{ value: T; ms: number }> | { value: T; ms: number } {
    const startedAtMs = nowMs();
    try {
      const out = fn();
      if (isPromiseLike(out)) {
        return (async () => {
          let durationMs: number | undefined;
          try {
            const value = await out;
            durationMs = nowMs() - startedAtMs;
            return { value, ms: Math.round(durationMs) };
          } finally {
            durationMs ??= nowMs() - startedAtMs;
            emit(span, durationMs, fields);
          }
        })();
      }

      const durationMs = nowMs() - startedAtMs;
      emit(span, durationMs, fields);
      return { value: out, ms: Math.round(durationMs) };
    } catch (error) {
      const durationMs = nowMs() - startedAtMs;
      emit(span, durationMs, fields);
      throw error;
    }
  }

  return { trace };
}

export const trace: Tracer = createTracer();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}
