import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ENGINE_SOURCE_PATHS = [
  'packages/ts/src',
  ':(exclude)packages/ts/src/__tests__',
  'packages/ts/package.json',
  'packages/ts/tsup.config.ts',
  'packages/ts/tsconfig.json',
  'packages/ts/examples/http-server',
]

const GIT_TIMEOUT_MS = 30_000

export interface EngineSourceIdentity {
  /** The version `packages/ts/package.json` declares. */
  version: string
  /** The tag that published that version. */
  releaseTag: string
  /** Whether that tag exists in this checkout. */
  releaseTagExists: boolean
  /** Whether every engine source path matches the tag. */
  matchesReleaseTag: boolean
  /** The engine source paths that differ from the tag, empty when none do. */
  changedPaths: string[]
}

function git(args: string[], cwd: string): { status: number; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
  if (result.error !== undefined) return { status: -1, stdout: '' }
  return { status: result.status ?? -1, stdout: (result.stdout ?? '').trim() }
}

function readEngineVersion(repoRoot: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(repoRoot, 'packages', 'ts', 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/**
 * Compares the engine sources in this checkout with the tag that published the
 * version they declare, so a run records whether it measured that release or
 * something ahead of it. Whatever cannot change what the engine does takes no
 * part: the engine's own tests, the example apps, this harness, and generated
 * results.
 *
 * @param cwd - A directory inside the repository.
 * @returns The declared version, its release tag, and which engine paths differ,
 * or null when git or the version cannot be read.
 */
export function readEngineSourceIdentity(cwd: string): EngineSourceIdentity | null {
  const root = git(['rev-parse', '--show-toplevel'], cwd)
  if (root.status !== 0 || root.stdout === '') return null

  const repoRoot = root.stdout
  const version = readEngineVersion(repoRoot)
  if (version === null) return null

  const releaseTag = `narsil-ts@v${version}`
  const tag = git(['rev-parse', '--verify', '--quiet', `${releaseTag}^{commit}`], repoRoot)
  if (tag.status !== 0) {
    return { version, releaseTag, releaseTagExists: false, matchesReleaseTag: false, changedPaths: [] }
  }

  const comparison = git(['diff', '--name-only', releaseTag, '--', ...ENGINE_SOURCE_PATHS], repoRoot)
  if (comparison.status !== 0) {
    return { version, releaseTag, releaseTagExists: true, matchesReleaseTag: false, changedPaths: [] }
  }

  const changedPaths = comparison.stdout === '' ? [] : comparison.stdout.split('\n')
  return {
    version,
    releaseTag,
    releaseTagExists: true,
    matchesReleaseTag: changedPaths.length === 0,
    changedPaths,
  }
}

/**
 * Reports whether the engine sources differ from the release they declare,
 * treating a comparison that cannot run as a difference so an unverifiable
 * build is never recorded as the release.
 *
 * @param cwd - A directory inside the repository.
 * @returns True when the sources differ from the tag or the comparison fails.
 */
export function engineSourceDiffersFromRelease(cwd: string): boolean {
  return readEngineSourceIdentity(cwd)?.matchesReleaseTag !== true
}
