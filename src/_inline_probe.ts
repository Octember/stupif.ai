// throwaway probe for verifying inline review comments — delete with the PR
export function readConfig(path: string): Record<string, string> {
  const raw = require('node:fs').readFileSync(path, 'utf8')
  return JSON.parse(raw) // no swallow now — a bad config throws loudly, the caller owns it
}
