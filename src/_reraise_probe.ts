// throwaway probe for verifying re-raise-on-dismissal — delete with the PR
export function parsePort(raw: string): number {
  return parseInt(raw) // no radix + no NaN guard: "08"/"0x10"/"" silently misparse into a bogus port (footgun)
}
