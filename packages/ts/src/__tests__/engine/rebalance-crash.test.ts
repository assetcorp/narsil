import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { Narsil } from '../../types/engine'
import { expectLayout, idsFrom } from './partition-layout-oracle'

const CHILD_SCRIPT = fileURLToPath(new URL('./rebalance-crash-child.mjs', import.meta.url))
const BUILT = existsSync(new URL('../../../dist/index.mjs', import.meta.url))
const INDEX = 'items'
const DOCUMENTS = 10_000
const WRITERS = 64
const MIN_ACKNOWLEDGED_WRITES = WRITERS / 4
const LATER_DOCUMENTS = 50
const CHILD_TIMEOUT_MS = 60_000

interface Acknowledged {
  removed: string[]
  inserted: string[]
  lines: number
}

function runUntilKilled(directory: string, killAt: string, firstCount: number, targetCount: number) {
  const child: ChildProcess = spawn(process.execPath, [CHILD_SCRIPT], {
    env: {
      ...process.env,
      NARSIL_DIR: directory,
      NARSIL_KILL_AT: killAt,
      NARSIL_FIRST_COUNT: String(firstCount),
      NARSIL_TARGET_COUNT: String(targetCount),
      NARSIL_DOCUMENTS: String(DOCUMENTS),
      NARSIL_WRITERS: String(WRITERS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise<Acknowledged>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
    child.on('error', reject)
    child.on('exit', (_code, signal) => {
      clearTimeout(timer)
      const lines = stdout.split('\n').filter(line => line.length > 0)
      if (signal !== 'SIGKILL' || !lines.includes('READY') || lines.some(line => line.startsWith('DONE'))) {
        reject(new Error(`The child ended without reaching ${killAt}: ${lines.slice(-3).join(' | ')} ${stderr}`))
        return
      }
      const removed: string[] = []
      const inserted: string[] = []
      for (const line of lines) {
        const [ack, action, id] = line.split(' ')
        if (ack !== 'ACK' || id === undefined) continue
        if (action === 'remove') removed.push(id)
        else inserted.push(id)
      }
      resolve({ removed, inserted, lines: removed.length + inserted.length })
    })
  })
}

function numberOf(id: string): number {
  return Number(id.slice(1))
}

function writesInFlight(acknowledged: Acknowledged): string[] {
  const inFlight: string[] = []
  for (let writer = 0; writer < WRITERS; writer++) {
    const removed = acknowledged.removed.filter(id => numberOf(id) % WRITERS === writer).length
    const inserted = acknowledged.inserted.filter(id => numberOf(id) % WRITERS === writer).length
    inFlight.push(removed > inserted ? `n${writer + inserted * WRITERS}` : `d${writer + removed * WRITERS}`)
  }
  return inFlight
}

async function expectedTitles(engine: Narsil, acknowledged: Acknowledged): Promise<Map<string, string>> {
  const titles = new Map(idsFrom('d', 0, DOCUMENTS).map(id => [id, `alpha ${id}`]))
  for (const id of acknowledged.removed) titles.delete(id)
  for (const id of acknowledged.inserted) titles.set(id, `beta ${id}`)
  for (const id of writesInFlight(acknowledged)) {
    const held = await engine.get(INDEX, id)
    if (id.startsWith('d') && held === undefined) titles.delete(id)
    if (id.startsWith('n') && held !== undefined) titles.set(id, `beta ${id}`)
  }
  return titles
}

describe.skipIf(!BUILT)('a process killed while a rebalance saves its new layout', { timeout: 180_000 }, () => {
  let directory = ''
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-rebalance-crash-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  async function open(): Promise<Narsil> {
    await engine?.shutdown()
    engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    return engine
  }

  it.each([
    ['after-metadata', 8, 3],
    ['after-manifest', 8, 3],
    ['after-metadata', 3, 4],
    ['after-manifest', 3, 4],
  ])('keeps every acknowledged write and one whole layout after a kill %s of %i to %i partitions', async (killAt, firstCount, targetCount) => {
    const acknowledged = await runUntilKilled(directory, killAt, firstCount, targetCount)
    expect(acknowledged.lines).toBeGreaterThanOrEqual(MIN_ACKNOWLEDGED_WRITES)

    const recovered = await open()
    const partitionCount = recovered.getPartitionStats(INDEX).length
    expect([firstCount, targetCount]).toContain(partitionCount)
    const titles = await expectedTitles(recovered, acknowledged)
    await expectLayout(recovered, INDEX, titles, partitionCount)
    for (const id of acknowledged.removed) expect(await recovered.get(INDEX, id), id).toBeUndefined()

    const later = idsFrom('later', 0, LATER_DOCUMENTS)
    for (const id of later) await recovered.insert(INDEX, { title: `gamma ${id}` }, id)
    for (const id of later) titles.set(id, `gamma ${id}`)
    await recovered.checkpoint(INDEX)
    await expectLayout(await open(), INDEX, titles, partitionCount)
  })
})
