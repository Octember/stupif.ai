#!/usr/bin/env bun
/**
 * stupify prime — emit the pre-decided taste (rubric + corpus index) as a Claude Code SessionStart hook
 * payload, so a coding session opens already holding your standard instead of only catching slop in review.
 *
 * Dependency-free (node builtins only) ON PURPOSE: `stupify prime --install` drops a copy of THIS file at
 * ~/.stupify/prime.ts and points the hook at it, so the hook runs fast with no global install and no
 * node_modules. Pure file read — no model, no network. It must NEVER break session start: any miss or error
 * emits nothing and exits 0. stdout is ONLY the JSON payload (a stray byte makes Claude Code drop it).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.STUPIFY_HOME ?? join(homedir(), '.stupify')

/** Resolve taste like the reviewer does (the repo you're coding in wins, else the pack taste setup assembled)
 *  and build the SessionStart payload. Returns null when no taste is set up — caller emits nothing. */
export function primePayload(cwd: string = process.cwd(), home: string = HOME): string | null {
  const dir = [join(cwd, '.review'), join(home, '.review')].find(
    (d) => existsSync(join(d, 'RUBRIC.md')) && existsSync(join(d, 'CORPUS.md')),
  )
  if (dir === undefined) return null
  const rubric = readFileSync(join(dir, 'RUBRIC.md'), 'utf8').trim()
  const corpus = readFileSync(join(dir, 'CORPUS.md'), 'utf8').trim()
  const additionalContext = `# Your taste, loaded by stupify — write to this standard

You're about to write or change code in this repo. Hold every edit to the standard below BEFORE you write it —
it's the same taste stupify reviews against, so matching it now is a clean review later.

## What counts as slop here — don't ship it (RUBRIC)
${rubric}

## The code yours should look like (CORPUS)
The links are commit-pinned exemplars — open one only if a finding needs the detail; never paste them in wholesale.
${corpus}`
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })
}

/** Write the payload to stdout, or nothing. Swallows every error: a hook must never disrupt session start. */
export function emitPrime(): void {
  try {
    const payload = primePayload()
    if (payload !== null) process.stdout.write(payload)
  } catch {
    /* never break session start */
  }
}

if (import.meta.main) emitPrime() // run directly (the installed hook calls `bun ~/.stupify/prime.ts`)
