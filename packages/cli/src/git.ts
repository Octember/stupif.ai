import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareDiff } from "./diff.js";
import type { DiffInput } from "./types.js";

const execFileAsync = promisify(execFile);

export async function readDiffForCommit(commit: string): Promise<DiffInput> {
  const [raw, message] = await Promise.all([commitDiff(commit), commitMessage(commit)]);
  if (!raw.trim()) throw new Error(`No diff found for commit ${commit}.`);
  return prepareDiff(raw, message.trim() || undefined);
}

async function commitDiff(commit: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--unified=0",
      `${commit}^1`,
      commit,
      "--",
    ], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw new Error(`Could not diff commit ${commit}.`);
  }
}

async function commitMessage(commit: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["show", "--no-patch", "--format=%B", commit], {
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    throw new Error(`Could not read commit message for ${commit}.`);
  }
}
