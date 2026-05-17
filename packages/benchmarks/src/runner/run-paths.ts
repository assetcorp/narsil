import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '..', '..')

const ARTIFACT_FILENAMES = {
  comparative: 'results.json',
  synthetic: 'synthetic-results.json',
  scenarios: 'scenario-results.json',
  memoryProfile: 'memory-profile.json',
  heapSnapshot: 'heap.heapsnapshot',
} as const

export type RunArtifact = keyof typeof ARTIFACT_FILENAMES

export interface RunFolderOptions {
  /** Override the package root. Used by tests; defaults to the benchmarks package. */
  packageRoot?: string
  /** Override the run timestamp. Used by tests. Defaults to `new Date()`. */
  now?: Date
  /** Override the runs directory name beneath the package root. Defaults to `runs`. */
  runsDirName?: string
}

export interface PreparedRun {
  /** The absolute path to the timestamped run folder. */
  runDir: string
  /** The absolute path to the `latest` symlink, after it has been updated. */
  latestSymlink: string
  /** ISO timestamp the folder was created with. */
  timestamp: string
  /** The absolute path to `META.txt` inside `runDir`. */
  metaPath: string
}

export interface PreparedArtifact extends PreparedRun {
  /** The absolute path to write this artifact to inside `runDir`. */
  artifactPath: string
}

interface GitInfo {
  branch: string
  commit: string
  dirty: boolean
}

function formatTimestamp(date: Date): string {
  const iso = date.toISOString()
  return iso.replace(/:/g, '-').replace(/\./g, '-')
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

function collectGitInfo(cwd: string): GitInfo {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? 'unknown'
  const commit = runGit(['rev-parse', 'HEAD'], cwd) ?? 'unknown'
  const status = runGit(['status', '--porcelain'], cwd)
  const dirty = status === null ? false : status.length > 0
  return { branch, commit, dirty }
}

function buildMetaContent(timestamp: string, git: GitInfo): string {
  const lines = [
    `date=${timestamp}`,
    `commit=${git.commit}`,
    `branch=${git.branch}`,
    `dirty=${git.dirty ? 'true' : 'false'}`,
    `node=${process.version}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
  ]
  return `${lines.join('\n')}\n`
}

function atomicReplaceSymlink(target: string, linkPath: string): void {
  const stagingPath = `${linkPath}.new-${process.pid}-${Date.now().toString(36)}`
  try {
    rmSync(stagingPath, { force: true })
  } catch {
    /*
     * A pre-existing staging entry from a prior crashed invocation must not
     * block the new symlink. force:true treats missing entries as success.
     */
  }
  symlinkSync(target, stagingPath)
  renameSync(stagingPath, linkPath)
}

export function prepareRunFolder(options: RunFolderOptions = {}): PreparedRun {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT
  const runsDirName = options.runsDirName ?? 'runs'
  const now = options.now ?? new Date()

  if (Number.isNaN(now.getTime())) {
    throw new TypeError('run-paths: options.now is not a valid Date')
  }

  const timestamp = formatTimestamp(now)
  const runsDir = resolve(packageRoot, runsDirName)
  const runDir = resolve(runsDir, timestamp)
  const latestSymlink = resolve(runsDir, 'latest')

  mkdirSync(runDir, { recursive: true })

  const git = collectGitInfo(packageRoot)
  const metaPath = resolve(runDir, 'META.txt')
  writeFileSync(metaPath, buildMetaContent(now.toISOString(), git), { mode: 0o644 })

  atomicReplaceSymlink(timestamp, latestSymlink)

  return { runDir, latestSymlink, timestamp, metaPath }
}

export function artifactFilename(artifact: RunArtifact): string {
  return ARTIFACT_FILENAMES[artifact]
}

export function prepareRunArtifact(artifact: RunArtifact, options: RunFolderOptions = {}): PreparedArtifact {
  const run = prepareRunFolder(options)
  const filename = artifactFilename(artifact)
  return { ...run, artifactPath: resolve(run.runDir, filename) }
}
