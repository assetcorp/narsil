import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expectEveryPhaseMatchesOracle,
  REMOVAL_PROCESS_SCRIPT,
  REPOSITORY_ROOT,
  readRemovalOutcome,
  removalPlan,
  runCommand,
  writeRemovalJob,
} from './harness'

const MEGABYTE_BYTES = 1024 * 1024
const CONTAINER_MEMORY_MEGABYTES = 1024
const REMOVAL_INDEX_GUARD_FRACTION = 0.9
const RESIDENT_FILL_FRACTION = 0.92
const NODE_IMAGE = 'node:24-bookworm-slim@sha256:8579e5fce559544b50072d05cc5d3b84b6a14d0989ae56c331d9e983a36a21f1'
const DOCUMENTS = 8_000
const BATCH_DOCUMENTS = 500
const FULL_BATCHES = 2
const MIN_REMOVAL_INDEX_BYTES_PER_DOCUMENT = 16

let workDirectory: string | null = null
let containerName: string | null = null

afterEach(async () => {
  if (containerName !== null) await runCommand('docker', ['rm', '-f', containerName])
  containerName = null
  if (workDirectory !== null) await rm(workDirectory, { recursive: true, force: true })
  workDirectory = null
})

const dockerReachable = (await runCommand('docker', ['info', '--format', '{{.OSType}}'])).output.trim() === 'linux'

function userFlags(): string[] {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return []
  return ['--user', `${process.getuid()}:${process.getgid()}`]
}

describe('removes from a frozen segment under a container memory limit', () => {
  it.skipIf(!dockerReachable)(
    'recounts from the postings while the process is full and builds the index once memory allows',
    async () => {
      workDirectory = await mkdtemp(join(tmpdir(), 'narsil-container-removes-'))
      const plan = { ...removalPlan(DOCUMENTS, BATCH_DOCUMENTS, FULL_BATCHES + 1), releaseFillBefore: FULL_BATCHES }
      const jobPath = await writeRemovalJob(workDirectory, plan, { kind: 'resident', fraction: RESIDENT_FILL_FRACTION })
      containerName = `narsil-container-removes-${randomUUID()}`
      const run = await runCommand('docker', [
        'run',
        '--rm',
        '--name',
        containerName,
        `--memory=${CONTAINER_MEMORY_MEGABYTES}m`,
        `--memory-swap=${CONTAINER_MEMORY_MEGABYTES}m`,
        ...userFlags(),
        '--volume',
        `${REPOSITORY_ROOT}:${REPOSITORY_ROOT}:ro`,
        '--volume',
        `${workDirectory}:${workDirectory}`,
        NODE_IMAGE,
        'node',
        '--expose-gc',
        REMOVAL_PROCESS_SCRIPT,
        jobPath,
      ])
      containerName = null
      expect(run.code, run.output).toBe(0)
      const outcome = await readRemovalOutcome(workDirectory)
      const limitBytes = outcome.processLimitBytes ?? 0
      expect(limitBytes).toBe(CONTAINER_MEMORY_MEGABYTES * MEGABYTE_BYTES)
      expect(outcome.filledResidentBytes).toBeGreaterThanOrEqual(REMOVAL_INDEX_GUARD_FRACTION * limitBytes)
      expectEveryPhaseMatchesOracle(plan, outcome)

      const indexFloor = MIN_REMOVAL_INDEX_BYTES_PER_DOCUMENT * DOCUMENTS
      const fullPhases = outcome.phases.slice(0, FULL_BATCHES)
      for (const phase of fullPhases) {
        expect(phase.estimatedMemoryBytes - outcome.loadedBytes).toBeLessThan(indexFloor)
      }
      const lastFull = fullPhases[fullPhases.length - 1]
      const afterRelease = outcome.phases[FULL_BATCHES]
      expect(afterRelease.residentBytes).toBeLessThan(REMOVAL_INDEX_GUARD_FRACTION * limitBytes)
      expect(afterRelease.estimatedMemoryBytes - lastFull.estimatedMemoryBytes).toBeGreaterThanOrEqual(indexFloor)
    },
    300_000,
  )
})
