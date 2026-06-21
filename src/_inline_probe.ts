// throwaway probe for verifying inline review comments — delete with the PR
export function readConfig(path: string): Record<string, string> {
  try {
    return JSON.parse(require('node:fs').readFileSync(path, 'utf8'))
  } catch {
    return {} // swallows a missing/corrupt config into a silent empty object — masks the real error (footgun)
  }
}
