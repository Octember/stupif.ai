import type { DiffInput, StupifyCheck } from "./types.js";

export function findingsPrompt(diff: DiffInput, checks: readonly StupifyCheck[]): string {
  const hunkNote = diff.hunkCount > 0 ? "Use one of the provided hunk labels for proof." : "Use hunk-1 for proof.";
  const commitMessage = diff.commitMessage
    ? `COMMIT MESSAGE:\n${diff.commitMessage}\n\n`
    : "";

  return `You are Stupify.
Stupify checks whether AI may be making a developer dumber by looking at a git diff.
You will receive:
1. An optional commit message.
2. A git diff.
3. A registry of checks.
Use only the checks in the registry.
Do not invent new check types.
Return findings only when the evidence is meaningful.
Prefer no finding over a weak finding.
For each check:
- strongSignals describe what should count
- weakSignals are not enough by themselves
- falsePositives are reasons to avoid flagging something
Return JSON only:
{
  "findings": [
    {
      "checkId": "string",
      "score": 0,
      "confidence": 0,
      "why": "one sentence",
      "proof": "short pointer"
    }
  ]
}
Rules:
- max 5 findings
- Do not quote code.
- Do not include long identifiers.
- Do not moralize.
- If nothing meaningful is found, return { "findings": [] }.
- ${hunkNote}

CHECK REGISTRY:
${JSON.stringify(checks, null, 2)}

${commitMessage}\
DIFF:
${diff.text}`;
}
