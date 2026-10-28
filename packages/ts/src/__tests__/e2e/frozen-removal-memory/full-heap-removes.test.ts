import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expectEveryPhaseMatchesOracle,
  REMOVAL_PROCESS_SCRIPT,
  readRemovalOutcome,
  removalPlan,
  runCommand,
  writeRemovalJob,
} from './harness'

const MEGABYTE_BYTES = 1024 * 1024
const NODE_HEAP_MEGABYTES = 192
const CLUSTER_DEFAULT_BLOCK_FRACTION = 0.9
const DOCUMENTS = 8_000
const BATCH_DOCUMENTS = 500

let workDirectory: string | null = null

afterEach(async () => {
  if (workDirectory !== null) await rm(workDirectory, { recursive: true, force: true })
  workDirectory = null
})

describe('removes from a frozen segment on a node whose heap is full', () => {
  it('keeps a 192 MiB heap process up at the cluster block fraction and matches the oracle', async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'narsil-full-heap-removes-'))
    const plan = removalPlan(DOCUMENTS, BATCH_DOCUMENTS, 2)
    const jobPath = await writeRemovalJob(workDirectory, plan, {
      kind: 'heap',
      limitBytes: NODE_HEAP_MEGABYTES * MEGABYTE_BYTES,
      fraction: CLUSTER_DEFAULT_BLOCK_FRACTION,
    })
    const run = await runCommand(process.execPath, [
      `--max-old-space-size=${NODE_HEAP_MEGABYTES}`,
      REMOVAL_PROCESS_SCRIPT,
      jobPath,
    ])
    expect(run.code, run.output).toBe(0)
    const outcome = await readRemovalOutcome(workDirectory)
    expect(outcome.filledHeapBytes).toBeGreaterThanOrEqual(
      CLUSTER_DEFAULT_BLOCK_FRACTION * NODE_HEAP_MEGABYTES * MEGABYTE_BYTES,
    )
    expectEveryPhaseMatchesOracle(plan, outcome)
  }, 300_000)
})
