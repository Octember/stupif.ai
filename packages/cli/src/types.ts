declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type SourceId = Brand<string, "SourceId">;
export type CheckId = Brand<string, "CheckId">;

export function sourceId(value: string): SourceId {
  return value as SourceId;
}

export function checkId(value: string): CheckId {
  return value as CheckId;
}

export type Command =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "stdin"; checkIds: readonly string[] | null; json: boolean; model: ModelId }>
  | Readonly<{ kind: "commit"; commit: string; checkIds: readonly string[] | null; json: boolean; model: ModelId }>
  | Readonly<{ kind: "commits"; count: number; checkIds: readonly string[] | null; json: boolean; model: ModelId }>;

export type AnalyzeCommand = Exclude<Command, Readonly<{ kind: "help" }>>;

export type ChangeArtifact = Readonly<{
  id: SourceId;
  label: string;
  text: string;
}>;

export type ModelInput = Readonly<{
  id: string;
  artifacts: readonly ChangeArtifact[];
}>;

export type StupifyCheck = Readonly<{
  id: CheckId;
  name: string;
  question: string;
  matchWhen: readonly string[];
  doNotMatchWhen: readonly string[];
  examples?: Readonly<{
    match?: readonly string[];
    noMatch?: readonly string[];
  }>;
}>;

export type FindingCandidate = Readonly<{
  sourceId: string;
  checkId: string;
  why: string;
  proof: string;
}>;

export type FindingsCandidate = Readonly<{
  findings: readonly FindingCandidate[];
}>;

export type Finding = Readonly<{
  sourceId: SourceId;
  checkId: CheckId;
  why: string;
  proof: string;
}>;

export type FindingsResult = Readonly<{
  findings: readonly Finding[];
}>;

export type ModelId =
  | "qwen3-4b-magicquant"
  | "qwen2.5-coder-1.5b"
  | "qwen2.5-coder-7b"
  | "qwen2.5-coder-32b";

export type ModelConfig = Readonly<{
  id: ModelId;
  name: string;
  size: string;
  file: string;
  url: string;
}>;
