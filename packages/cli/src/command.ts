import type { Command } from "./types.js";

export function parseCommand(argv: readonly string[]): Command {
  if (argv.length === 1 && isHelp(argv[0])) {
    return { kind: "help" };
  }

  let kind: "stdin" | "commit" | null = null;
  let commit = "";
  let checkIds: readonly string[] | null = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdin") kind = "stdin";
    else if (arg === "--json") json = true;
    else if (arg === "--commit") {
      const value = argv[++index];
      if (!value || !isSafeCommitArg(value)) throw new Error("Invalid commit.");
      kind = "commit";
      commit = value;
    } else if (arg === "--checks") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error("--checks requires a comma-separated list.");
      checkIds = value.split(",").map((id) => id.trim()).filter(Boolean);
      if (checkIds.length === 0) throw new Error("--checks requires at least one check id.");
    } else throw new Error(`Unknown option: ${arg}`);
  }

  if (kind === "stdin") return { kind, checkIds, json };
  if (kind === "commit") return { kind, commit, checkIds, json };
  throw new Error("Usage: stupify --commit <commit>");
}

function isSafeCommitArg(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && /^[A-Za-z0-9._/@~^:+-]+$/.test(value);
}

function isHelp(value: string): boolean {
  return value === "--help" || value === "-h";
}
