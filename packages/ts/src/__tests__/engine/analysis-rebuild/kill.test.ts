import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import type { StaleAnalysis } from '../../../types/config'
import { expectAnswersFrom } from './answers'
import {
  FIRST_REVISION,
  LANGUAGE,
  OracleCorpus,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
} from './oracle'

const CHILD_SCRIPT = fileURLToPath(new URL('./child-rebuild-dist.mjs', import.meta.url))
const built = existsSync(new URL('../../../../dist/index.mjs', import.meta.url))

const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 30_000
const PARTITIONS = 4
const CHILD_WRITES = 10

type KillPoint = 'during-rebuild' | 'after-checkpoint'

function runChildUntilReady(directory: string, killAt: KillPoint): Promise<{ child: ChildProcess; line: string }> {
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

describe.skipIf(!built)('a process killed while its index is due a rebuild', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-analysis-kill-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  async function writeUnderFirstRevision(): Promise<OracleCorpus> {
    const corpus = new OracleCorpus()
    registerRevision(FIRST_REVISION)
    const random = seededRandom(53)
    const writer = await createNarsil({ durability: { directory: dir }, workers: { enabled: false } })
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus.write(document.id, document.title, FIRST_REVISION)
    await writer.rebalance('prose', PARTITIONS)
    await writer.checkpoint('prose')
    await writer.shutdown()
    registerRevision(SECOND_REVISION)
    for (let i = 0; i < CHILD_WRITES; i++) corpus.write(`child-${i}`, 'jumping stone', SECOND_REVISION)
    corpus.remove('doc-1')
    return corpus
  }

  it('finishes the rebuild on its own after a kill in the middle of one', async () => {
    const corpus = await writeUnderFirstRevision()
    const { child, line } = await runChildUntilReady(dir, 'during-rebuild')
    await kill(child)
    expect(line).toBe('READY')

    const reported: StaleAnalysis[] = []
    let completed: () => void = () => undefined
    const rebuilt = new Promise<void>(resolve => {
      completed = resolve
    })
    engine = await createNarsil({
      durability: { directory: dir },
      workers: { enabled: false },
      analysis: { onStaleAnalysis: index => void reported.push(index) },
    })
    engine.on('analysisRebuild', payload => {
      if (payload.status === 'completed') completed()
    })

    expect(reported.map(index => index.storedRevision)).toEqual([FIRST_REVISION])
    await rebuilt
    await expectAnswersFrom(engine, corpus, 'new')
    expect(await engine.countDocuments('prose')).toBe(corpus.size)
  }, 120_000)

  it('announces the rebuild again after a kill that follows a checkpoint taken while it was due', async () => {
    const corpus = await writeUnderFirstRevision()
    const { child, line } = await runChildUntilReady(dir, 'after-checkpoint')
    await kill(child)
    expect(line).toBe('READY')

    const reported: StaleAnalysis[] = []
    engine = await createNarsil({
      durability: { directory: dir },
      workers: { enabled: false },
      analysis: { rebuild: 'manual', onStaleAnalysis: index => void reported.push(index) },
    })

    expect(reported.map(index => [index.storedRevision, index.currentRevision])).toEqual([
      [FIRST_REVISION, SECOND_REVISION],
    ])
    await expectAnswersFrom(engine, corpus, 'old')

    await engine.rebuildAnalysis('prose')
    await expectAnswersFrom(engine, corpus, 'new')
    expect(await engine.countDocuments('prose')).toBe(corpus.size)
  }, 120_000)
})
