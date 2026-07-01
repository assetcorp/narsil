import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJsonAtomicSync } from './atomic-write'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '..', '..')

const RESULTS_DIRNAME = 'results'
const RUNS_DIRNAME = 'runs'
const MANIFEST_NAME = 'run.json'

const ARTIFACT_FILENAMES = {
  comparative: 'results.json',
  memoryProfile: 'memory-profile.json',
  heapSnapshot: 'heap.heapsnapshot',
} as const

export type RunArtifact = keyof typeof ARTIFACT_FILENAMES

/*
 * A run id becomes a single directory segment under the results tree. The
 * leading-alphanumeric rule rejects '.', '..', and option-like leading dashes;
 * the body allows only the characters a UTC timestamp id uses, so a hostile id
 * cannot carry a path separator, climb out with a dot entry, or smuggle a null
 * byte. This mirrors the server suite's run-store segment guard.
 */
const RUN_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

export interface RunFolderOptions {
  /** Override the package root. Used by tests; defaults to the benchmarks package. */
  packageRoot?: string
  /** Override the run timestamp. Used by tests. Defaults to `new Date()`. */
  now?: Date
  /** Override the run id directly. Used by tests; defaults to a minted timestamp. */
  runId?: string
}

export interface RunEnvironment {
  node: string
  os: string
  arch: string
  cpu: string
  totalMemory: string
}

export interface RunGitIdentity {
  branch: string
  commit: string
  dirty: boolean
}

export interface RunManifest {
  runId: string
  createdAt: string
  git: RunGitIdentity
  environment: RunEnvironment
}

export interface PreparedRun {
  /** The absolute path to the timestamped run folder. */
  runDir: string
  /** The run id, which is also the run folder name. */
  runId: string
  /** The absolute path to `run.json` inside `runDir`. */
  manifestPath: string
  /** The manifest written for this run. */
  manifest: RunManifest
}

export interface PreparedArtifact extends PreparedRun {
  /** The absolute path to write this artifact to inside `runDir`. */
  artifactPath: string
}

export class InvalidRunIdError extends Error {
  readonly code = 'invalid-run-id'
  readonly runId: string

  constructor(runId: string) {
    super(
      `invalid run id ${JSON.stringify(runId)}: expected 1 to 64 characters of letters, digits, dot, dash, or underscore, not starting with a dot or dash`,
    )
    this.name = 'InvalidRunIdError'
    this.runId = runId
  }
}

export function mintRunId(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) {
    throw new TypeError('run-paths: now is not a valid Date')
  }
  const iso = now.toISOString()
  const date = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
  return `${date}T${time}Z`
}

export function validateRunId(runId: string): string {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new InvalidRunIdError(runId)
  }
  return runId
}

function resultsRoot(packageRoot: string): string {
  return resolve(packageRoot, RESULTS_DIRNAME)
}

export function runsRoot(packageRoot: string = PACKAGE_ROOT): string {
  return resolve(resultsRoot(packageRoot), RUNS_DIRNAME)
}

export function runDirectory(runId: string, packageRoot: string = PACKAGE_ROOT): string {
  validateRunId(runId)
  const root = runsRoot(packageRoot)
  const candidate = resolve(root, runId)
  const rootWithSep = root.endsWith('/') ? root : `${root}/`
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw new InvalidRunIdError(runId)
  }
  return candidate
}

export function latestRunId(packageRoot: string = PACKAGE_ROOT): string | null {
  const root = runsRoot(packageRoot)
  if (!existsSync(root)) return null
  let best: string | null = null
  for (const entry of readdirSync(root)) {
    if (!RUN_ID_PATTERN.test(entry)) continue
    if (!statSync(resolve(root, entry)).isDirectory()) continue
    if (best === null || entry > best) best = entry
  }
  return best
}

function runGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5_000,
    })
    return out.trim()
  } catch {
    return null
  }
}

function collectGitIdentity(cwd: string): RunGitIdentity {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? 'unknown'
  const commit = runGit(['rev-parse', 'HEAD'], cwd) ?? 'unknown'
  const status = runGit(['status', '--porcelain'], cwd)
  const dirty = status === null ? false : status.length > 0
  return { branch, commit, dirty }
}

function collectEnvironment(): RunEnvironment {
  return {
    node: process.version,
    os: os.type(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    totalMemory: `${Math.round(os.totalmem() / 1024 ** 3)}GB`,
  }
}

function readExistingCreatedAt(manifestPath: string): string | null {
  if (!existsSync(manifestPath)) return null
  try {
    const prior = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Partial<RunManifest>
    return typeof prior.createdAt === 'string' ? prior.createdAt : null
  } catch {
    return null
  }
}

export function prepareRunFolder(options: RunFolderOptions = {}): PreparedRun {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT
  const now = options.now ?? new Date()
  if (Number.isNaN(now.getTime())) {
    throw new TypeError('run-paths: options.now is not a valid Date')
  }

  const runId = validateRunId(options.runId ?? mintRunId(now))
  const runDir = runDirectory(runId, packageRoot)
  mkdirSync(runDir, { recursive: true })

  const manifestPath = resolve(runDir, MANIFEST_NAME)
  const createdAt = readExistingCreatedAt(manifestPath) ?? now.toISOString()
  const manifest: RunManifest = {
    runId,
    createdAt,
    git: collectGitIdentity(packageRoot),
    environment: collectEnvironment(),
  }
  writeJsonAtomicSync(manifestPath, manifest)

  return { runDir, runId, manifestPath, manifest }
}

export function artifactFilename(artifact: RunArtifact): string {
  return ARTIFACT_FILENAMES[artifact]
}

export function prepareRunArtifact(artifact: RunArtifact, options: RunFolderOptions = {}): PreparedArtifact {
  const run = prepareRunFolder(options)
  const filename = artifactFilename(artifact)
  return { ...run, artifactPath: resolve(run.runDir, filename) }
}
