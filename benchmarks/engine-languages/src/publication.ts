import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  mintRunId,
  type PreparedRun,
  prepareRunFolder,
  type RunFolderOptions,
  runsRoot,
} from 'benchmarks/src/runner/run-paths'

export function publishRun(options: RunFolderOptions, write: (prepared: PreparedRun) => void): string {
  const destination = runsRoot(options.packageRoot, options.profile)
  mkdirSync(destination, { recursive: true })
  const staging = mkdtempSync(resolve(destination, '.partial-'))
  try {
    const prepared = prepareRunFolder({
      ...options,
      packageRoot: staging,
      runId: `${mintRunId(options.now)}-${randomUUID()}`,
    })
    write(prepared)
    const published = resolve(destination, prepared.runId)
    renameSync(prepared.runDir, published)
    return published
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
