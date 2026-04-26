export type Command =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "stdin"; checkIds: readonly string[] | null; json: boolean }>
  | Readonly<{ kind: "commit"; commit: string; checkIds: readonly string[] | null; json: boolean }>;

export type DiffInput = Readonly<{
  commitMessage?: string;
  text: string;
  hunkCount: number;
}>;

export type StupifyCheck = Readonly<{
  id: string;
  name: string;
  question: string;
  strongSignals: readonly string[];
  weakSignals: readonly string[];
  falsePositives: readonly string[];
  examples?: readonly Readonly<{
    bad: string;
    okay: string;
  }>[];
}>;

export type Finding = Readonly<{
  checkId: string;
  score: number;
  confidence: number;
  why: string;
  proof: string;
}>;

export type FindingsResult = Readonly<{
  findings: readonly Finding[];
}>;
