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

export type PublishedVersionErrorCode =
  | 'no-git-repository'
  | 'unreadable-engine-version'
  | 'missing-release-tag'
  | 'git-comparison-failed'
  | 'unpublished-engine-source'

export class PublishedVersionError extends Error {
  readonly code: PublishedVersionErrorCode

  constructor(code: PublishedVersionErrorCode, message: string) {
    super(message)
    this.name = 'PublishedVersionError'
    this.code = code
  }
}

export interface EngineSourceIdentity {
  /** The version `packages/ts/package.json` declares. */
  version: string
  /** The tag that published that version. */
  releaseTag: string
  /** Whether every engine source path matches the tag. */
  matchesReleaseTag: boolean
  /** The engine source paths that differ from the tag, empty when none do. */
  changedPaths: string[]
}

interface GitResult {
  status: number
  stdout: string
}

function git(args: string[], cwd: string): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
  if (result.error !== undefined) {
    throw new PublishedVersionError('git-comparison-failed', `git ${args.join(' ')} failed: ${result.error.message}`)
  }
  return { status: result.status ?? -1, stdout: (result.stdout ?? '').trim() }
}

function repositoryRoot(cwd: string): string {
  const { status, stdout } = git(['rev-parse', '--show-toplevel'], cwd)
  if (status !== 0 || stdout === '') {
    throw new PublishedVersionError(
      'no-git-repository',
      `no git repository at ${cwd}, so the engine source cannot be compared with its release tag`,
    )
  }
  return stdout
}

function readEngineVersion(repoRoot: string): string {
  const manifestPath = resolve(repoRoot, 'packages', 'ts', 'package.json')
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch {
    throw new PublishedVersionError('unreadable-engine-version', `cannot read ${manifestPath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PublishedVersionError('unreadable-engine-version', `${manifestPath} is not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PublishedVersionError('unreadable-engine-version', `${manifestPath} does not hold an object`)
  }
  const version = (parsed as Record<string, unknown>).version
  if (typeof version !== 'string' || version === '') {
    throw new PublishedVersionError('unreadable-engine-version', `${manifestPath} declares no version`)
  }
  return version
}

/**
 * Compares the engine sources in this checkout with the tag that published the
 * version they declare, so a run reports a version only when it measures that
 * version. Whatever cannot change what the engine does never counts as a
 * difference: the engine's own tests, the example apps, this harness, and
 * generated results.
 *
 * @param cwd - A directory inside the repository. Defaults to the process directory.
 * @returns The declared version, its release tag, and which engine paths differ.
 * @throws PublishedVersionError when git is unusable, the version is unreadable,
 * or no tag published that version.
 */
export function readEngineSourceIdentity(cwd: string = process.cwd()): EngineSourceIdentity {
  const repoRoot = repositoryRoot(cwd)
  const version = readEngineVersion(repoRoot)
  const releaseTag = `narsil-ts@v${version}`
  const tag = git(['rev-parse', '--verify', '--quiet', `${releaseTag}^{commit}`], repoRoot)
  if (tag.status !== 0) {
    throw new PublishedVersionError(
      'missing-release-tag',
      `packages/ts declares version ${version}, but no tag ${releaseTag} exists in this checkout, so there is nothing to compare it with`,
    )
  }
  const comparison = git(['diff', '--name-only', releaseTag, '--', ...ENGINE_SOURCE_PATHS], repoRoot)
  if (comparison.status !== 0) {
    throw new PublishedVersionError(
      'git-comparison-failed',
      `comparing the engine sources with ${releaseTag} exited ${comparison.status}`,
    )
  }
  const changedPaths = comparison.stdout === '' ? [] : comparison.stdout.split('\n')
  return { version, releaseTag, matchesReleaseTag: changedPaths.length === 0, changedPaths }
}

/**
 * Reads the engine source identity and refuses one that differs from its
 * release tag, so a publishable run cannot record a version it did not measure.
 *
 * @param cwd - A directory inside the repository. Defaults to the process directory.
 * @returns The identity, which always matches the release tag on return.
 * @throws PublishedVersionError when the sources differ from the tag, or when
 * the comparison itself cannot run.
 */
export function assertPublishedEngineSource(cwd: string = process.cwd()): EngineSourceIdentity {
  const identity = readEngineSourceIdentity(cwd)
  if (!identity.matchesReleaseTag) {
    const lines = [
      `the engine sources differ from ${identity.releaseTag} in ${identity.changedPaths.length} file(s), so this run would report version ${identity.version} for code that is not ${identity.version}:`,
      ...identity.changedPaths.map(path => `  ${path}`),
      'run with BENCH_PROFILE=smoke to measure the working tree instead.',
    ]
    throw new PublishedVersionError('unpublished-engine-source', lines.join('\n'))
  }
  return identity
}

/**
 * Reports whether the engine sources differ from their release tag, treating an
 * unusable comparison as a difference so an unverifiable build is never
 * recorded as a published one.
 *
 * @param cwd - A directory inside the repository.
 * @returns True when the sources differ or the comparison cannot run.
 */
export function engineSourceDiffersFromRelease(cwd: string): boolean {
  try {
    return !readEngineSourceIdentity(cwd).matchesReleaseTag
  } catch {
    return true
  }
}
