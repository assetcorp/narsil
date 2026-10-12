import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const FILE_LIMIT = vi.hoisted(() => 256 * 1024)

vi.mock('../../../serialization/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../serialization/constants')>()),
  MAX_FILE_BYTES: FILE_LIMIT,
}))

vi.mock('../../../persistence/durability/checkpoint-worker-dispatch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../persistence/durability/checkpoint-worker-dispatch')>()),
  checkpointWorkerIsUsable: () => false,
  runCheckpointOnWorker: async () => null,
}))

import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import { bytesOf } from './archive-oracle'
import { temporaryRoots } from './harness'

const roots = temporaryRoots()
const engines: Narsil[] = []
const DIMENSION = 16

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function checkpointInProcess(engine: Narsil, indexName: string): Promise<void> {
  return engine.checkpoint(indexName)
}

function track(engine: Narsil): Narsil {
  engines.push(engine)
  return engine
}

function vectorOf(seed: number): number[] {
  return Array.from({ length: DIMENSION }, (_, d) => Math.fround(Math.sin(seed * 13 + d * 7)))
}

function paragraph(n: number): string {
  const words = ['harbour', 'lantern', 'ferry', 'quay', 'slipway', 'beacon', 'tide', 'anchor', 'rope', 'gull']
  return Array.from({ length: 120 }, (_, w) => `${words[(n * 7 + w) % words.length]}${(n * 31 + w) % 997}`).join(' ')
}

async function filesOf(directory: string): Promise<Array<{ name: string; bytes: number }>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files.push({ name: path.slice(directory.length + 1), bytes: (await stat(path)).size })
  }
  return files
}

async function walEngine(): Promise<{ config: NarsilConfig; engine: Narsil; directory: string }> {
  const directory = await roots.make('narsil-file-limit-')
  const config: NarsilConfig = {
    workers: { enabled: false },
    durability: { directory, segmentMaxBytes: 128 * 1024 },
  }
  return { config, directory, engine: track(await createNarsil(config)) }
}

describe('an index larger than the file size limit', () => {
  it('splits its segments, its vector files, and its graph into files within the limit, and reopens whole', async () => {
    const { config, directory, engine } = await walEngine()
    await engine.createIndex('papers', {
      schema: { title: 'string', body: 'string', embedding: `vector[${DIMENSION}]` },
      vectorPromotion: { threshold: 16, hnswConfig: { m: 8, efConstruction: 32 } },
    })
    const documents = Array.from({ length: 900 }, (_, n) => ({
      id: `p${n}`,
      title: `paper ${n}`,
      body: paragraph(n),
      embedding: vectorOf(n),
    }))
    for (let start = 0; start < documents.length; start += 100) {
      expect((await engine.insertBatch('papers', documents.slice(start, start + 100))).failed).toEqual([])
    }
    await checkpointInProcess(engine, 'papers')
    const query = { vector: { field: 'embedding', value: vectorOf(451) }, limit: 5 }
    const expected = (await engine.query('papers', query)).hits.map(hit => hit.id)
    const harbour = (await engine.query('papers', { term: 'harbour1', limit: 1000 })).count
    await engine.shutdown()

    const files = await filesOf(directory)
    for (const file of files) expect(file.bytes, file.name).toBeLessThanOrEqual(FILE_LIMIT)
    const named = (pattern: RegExp) => files.filter(file => pattern.test(file.name)).length
    expect(named(/^papers\/segments\/0\/s\d{16}$/)).toBeGreaterThan(1)
    expect(named(/^papers\/segments\/vec-embedding-[a-z0-9]+-f\d{16}$/)).toBeGreaterThan(1)
    expect(named(/^papers\/segments\/vec-embedding-[a-z0-9]+-graph-g\d+-p\d{16}$/)).toBe(1)

    const reopened = track(await createNarsil(config))
    expect(await reopened.countDocuments('papers')).toBe(documents.length)
    expect((await reopened.query('papers', query)).hits.map(hit => hit.id)).toEqual(expected)
    expect((await reopened.query('papers', { term: 'harbour1', limit: 1000 })).count).toBe(harbour)
    expect((await reopened.vectorMaintenanceStatus('papers'))[0]).toMatchObject({ graphCount: 1, bufferSize: 0 })
    expect((await reopened.get('papers', 'p77'))?.body).toBe(paragraph(77))

    const copy = track(await createNarsil({ workers: { enabled: false } }))
    await copy.restore('papers', await bytesOf(await reopened.snapshot('papers')))
    expect((await copy.query('papers', query)).hits.map(hit => hit.id)).toEqual(expected)
  }, 120_000)

  it('refuses a checkpoint of one document that no file can hold, and keeps serving and logging writes', async () => {
    const { config, engine } = await walEngine()
    await engine.createIndex('notes', { schema: { title: 'string', body: 'string' } })
    await engine.insert('notes', { title: 'small', body: 'harbour' }, 'small')
    const distinctWords = Array.from({ length: 20_000 }, (_, at) => `w${at.toString(36)}`).join(' ')
    await engine.insert('notes', { title: 'large', body: distinctWords }, 'large')

    await expect(checkpointInProcess(engine, 'notes')).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_SAVE_FAILED,
    })

    await engine.insert('notes', { title: 'after', body: 'lantern' }, 'after')
    expect(await engine.countDocuments('notes')).toBe(3)
    await engine.remove('notes', 'large')
    await checkpointInProcess(engine, 'notes')
    await engine.shutdown()

    const reopened = track(await createNarsil(config))
    expect(await reopened.countDocuments('notes')).toBe(2)
    expect((await reopened.get('notes', 'after'))?.body).toBe('lantern')
  })
})
