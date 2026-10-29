import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import { savedShuffledBuildCount } from '../e2e/portability/archive-oracle'
import { temporaryRoots } from '../e2e/portability/harness'
import { waitFor } from '../server/helpers'
import {
  DIMENSION,
  EF_SEARCH_FOR_EVERY_PASSAGE,
  FIELD,
  insertFileByFile,
  NARROW_LIMIT,
  passagesArrivingFileByFile,
  passagesNotFoundFirst,
  SETTLE_TIMEOUT_MS,
  snapshotFromAnEarlierRelease,
  unreachedPassages,
  untilSettled,
} from './passages-by-file'

const CHILD_SCRIPT = fileURLToPath(new URL('./child-graph-repair-dist.mjs', import.meta.url))
const built = existsSync(new URL('../../../dist/index.mjs', import.meta.url))

const SAVED_PASSAGES = 2_000
const INDEX = 'passages'
const RESTORED_INDEX = 'earlier'
const TEST_TIMEOUT_MS = 300_000

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

async function opened(config: NarsilConfig): Promise<Narsil> {
  const engine = await createNarsil(config)
  engines.push(engine)
  return engine
}

function childRepairing(directory: string, snapshot: string): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: { ...process.env, NARSIL_DIR: directory, NARSIL_SNAPSHOT: snapshot },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const line = stdout.split('\n').find(candidate => candidate === 'REPAIRING' || candidate === 'IDLE')
      if (line !== undefined) resolve({ child, line })
    })
    child.on('exit', code => reject(new Error(`child exited with ${code} before the repair started: ${stderr}`)))
    child.on('error', reject)
  })
}

async function kill(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}

describe.skipIf(!built)('a process killed while it repairs a graph from an earlier release', () => {
  it(
    'repairs the graph again when the index next opens',
    async () => {
      const passages = passagesArrivingFileByFile(SAVED_PASSAGES)
      const source = await opened({ workers: { enabled: false } })
      await source.createIndex(INDEX, {
        schema: { [FIELD]: `vector[${DIMENSION}]` },
        vectorPromotion: { quantization: 'osq4', threshold: SAVED_PASSAGES },
      })
      await insertFileByFile(source, INDEX, passages)
      const snapshot = join(await roots.make('narsil-repair-snapshot-'), 'earlier.nrsl')
      await writeFile(snapshot, await snapshotFromAnEarlierRelease(source, INDEX, SAVED_PASSAGES))

      const directory = await roots.make('narsil-repair-kill-')
      const { child, line } = await childRepairing(directory, snapshot)
      await kill(child)
      expect(line).toBe('REPAIRING')
      expect(await savedShuffledBuildCount(directory, RESTORED_INDEX)).toBeNull()

      const reopened = await opened({ workers: { enabled: false }, durability: { directory, checkpointIntervalMs: 0 } })
      expect(await reopened.countDocuments(RESTORED_INDEX)).toBe(SAVED_PASSAGES)
      await waitFor(async () => (await savedShuffledBuildCount(directory, RESTORED_INDEX)) !== null, SETTLE_TIMEOUT_MS)
      await untilSettled(reopened, RESTORED_INDEX)
      expect(await savedShuffledBuildCount(directory, RESTORED_INDEX)).toBe(SAVED_PASSAGES)
      expect(await unreachedPassages(reopened, RESTORED_INDEX)).toEqual({ unplaced: [], unreached: [] })
      expect(
        await passagesNotFoundFirst(reopened, RESTORED_INDEX, passages, NARROW_LIMIT, EF_SEARCH_FOR_EVERY_PASSAGE),
      ).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
