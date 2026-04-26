import { findingsPrompt } from "./prompts.js";
import { isFindingsResult, sanitizeFindingsResult } from "./sanitize.js";
import type { LocalModel } from "./model.js";
import type { DiffInput, FindingsResult, StupifyCheck } from "./types.js";

export async function analyzeDiff(
  model: LocalModel,
  diff: DiffInput,
  checks: readonly StupifyCheck[],
): Promise<FindingsResult> {
  const grammar = await model.llama.createGrammarForJsonSchema({
    type: "object",
    properties: {
      findings: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            checkId: { type: "string" },
            score: { type: "number" },
            confidence: { type: "number" },
            why: { type: "string" },
            proof: { type: "string" },
          },
          required: ["checkId", "score", "confidence", "why", "proof"],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
    additionalProperties: false,
  });

  const raw = await model.session.prompt(findingsPrompt(diff, checks), { grammar, maxTokens: 420 });
  const parsed = parseModelJson(raw, grammar);
  if (!isFindingsResult(parsed)) {
    console.error("Raw model output:");
    console.error(raw);
    throw new Error("Model returned invalid findings JSON.");
  }
  return sanitizeFindingsResult(parsed, checks);
}

function parseModelJson(raw: string, grammar: { parse(input: string): unknown }): unknown {
  try {
    return grammar.parse(raw);
  } catch (error) {
    console.error("Raw model output:");
    console.error(raw);
    throw error;
  }
}
