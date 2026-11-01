import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import { waitFor } from '../../server/helpers'
import {
  allHitsOf,
  ChangeOracle,
  DASHES_SETTINGS,
  PLAIN_LANGUAGE,
  PROBES,
  registerFixtures,
  seededRandom,
  sentence,
} from './oracle'

const CHILD_SCRIPT = fileURLToPath(new URL('./child-change-dist.mjs', import.meta.url))
const built = existsSync(new URL('../../../../dist/index.mjs', import.meta.url))

const DOCUMENTS = 30_000
const PARTITIONS = 4
const CHILD_WRITES = 10

function childUntilReady(directory: string, killAt: string): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: { ...process.env, NARSIL_DIR: directory, NARSIL_KILL_AT: killAt },
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
      const line = stdout.split('\n').find(candidate => candidate === 'READY' || candidate === 'LATE')
      if (line !== undefined) resolve({ child, line })
    })
    child.on('exit', code => reject(new Error(`child exited with ${code} before it was ready: ${stderr}`)))
    child.on('error', reject)
  })
}

async function kill(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}

describe.skipIf(!built)('a process killed during an analysis change', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    registerFixtures()
    dir = await mkdtemp(join(tmpdir(), 'narsil-change-kill-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  it.each([
    'during-build',
    'after-checkpoint',
  ])('finishes the change and keeps every write after a kill at %s', async killAt => {
    const oracle = new ChangeOracle()
    const random = seededRandom(23)
    const writer = await createNarsil({ durability: { directory: dir }, workers: { enabled: false } })
    await writer.createIndex('prose', { schema: { title: 'string' }, language: PLAIN_LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    for (const document of documents) oracle.write(document.id, document.title)
    await writer.insertBatch('prose', documents)
    await writer.rebalance('prose', PARTITIONS)
    await writer.checkpoint('prose')
    await writer.shutdown()
    for (let i = 0; i < CHILD_WRITES; i++) oracle.write(`child-${i}`, 'sea-wall stone')
    oracle.remove('doc-1')

    const { child, line } = await childUntilReady(dir, killAt)
    await kill(child)
    expect(line).toBe('READY')

    engine = await createNarsil({ durability: { directory: dir }, workers: { enabled: false } })
    const reopened = engine
    await waitFor(async () => {
      const hits = await allHitsOf(reopened, 'prose', 'wall')
      return hits.join('\n') === oracle.matches('wall', DASHES_SETTINGS).join('\n')
    }, 60_000)
    for (const probe of PROBES) {
      expect(await allHitsOf(engine, 'prose', probe)).toEqual(oracle.matches(probe, DASHES_SETTINGS))
    }
  }, 120_000)
})
