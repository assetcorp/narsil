import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import { createNarsil, type Narsil } from '../../../narsil'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import { createServer } from '../../../server'
import type { PersistenceAdapter } from '../../../types/adapters'
import { decodedPayload } from '../../e2e/portability/archive-oracle'

async function listedBytes(directory: string): Promise<number> {
  const manifest = decodedPayload(await readFile(join(directory, 'docs/manifest')))
  const partitions = manifest.partitions as Array<{ segments: Array<{ key: string }> }>
  let total = 0
  for (const partition of partitions) {
    for (const segment of partition.segments) total += (await stat(join(directory, segment.key))).size
  }
  return total
}

describe('saved size after a committed checkpoint encounters a storage failure', () => {
  let engine: Narsil | null = null
  let directory = ''

  afterEach(async () => {
    await engine?.shutdown()
    if (directory !== '') await rm(directory, { recursive: true, force: true })
  })

  it.each([
    'list',
    'delete',
  ] as const)('reports the committed files when %s fails after the manifest write', async failure => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-size-commit-failure-'))
    const base = createFilesystemPersistence({ directory })
    let armed = false
    let committed = false
    const adapter: PersistenceAdapter = {
      ...base,
      async save(key, bytes) {
        await base.save(key, bytes)
        if (armed && key === 'docs/manifest') committed = true
      },
      async list(prefix) {
        if (committed && failure === 'list') throw new Error('Storage listing is unavailable')
        return base.list(prefix)
      },
      async delete(key) {
        if (committed && failure === 'delete') throw new Error('Storage deletion is unavailable')
        await base.delete(key)
      },
    }
    engine = await createNarsil({
      persistence: adapter,
      durability: { tier: 'snapshot', checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000 },
      workers: { enabled: false },
    })
    await engine.createIndex('docs', { schema: { title: 'string' } })
    await engine.insert('docs', { title: 'retained record' }, 'retained')
    await engine.checkpoint('docs')
    const previous = engine.getStats('docs').savedBytes
    await engine.insert('docs', { title: 'additional searchable record '.repeat(100) }, 'additional')
    armed = true
    await expect(engine.checkpoint('docs')).rejects.toThrow('Storage')
    expect(committed).toBe(true)
    const expected = await listedBytes(directory)
    expect(expected).not.toBe(previous)
    const reported = engine.getStats('docs').savedBytes
    const partitionReported = engine.getPartitionStats('docs')[0]?.savedBytes
    const server = createServer(engine, { host: '127.0.0.1', port: 0 })
    await server.listen()
    let httpReported: number | undefined
    let httpPartitionReported: number | undefined
    try {
      const client = createNarsilClient({ url: `http://127.0.0.1:${server.listeningPort}` })
      httpReported = (await client.getStats('docs')).savedBytes
      httpPartitionReported = (await client.getPartitionStats('docs'))[0]?.savedBytes
    } finally {
      await server.shutdown()
    }
    armed = false
    committed = false
    await engine.shutdown()
    engine = await createNarsil({
      persistence: base,
      durability: { tier: 'snapshot', checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000 },
      workers: { enabled: false },
    })
    expect(await engine.get('docs', 'additional')).toEqual({ title: 'additional searchable record '.repeat(100) })
    expect(engine.getStats('docs').savedBytes).toBe(expected)
    expect.soft(reported).toBe(expected)
    expect.soft(partitionReported).toBe(expected)
    expect.soft(httpReported).toBe(expected)
    expect.soft(httpPartitionReported).toBe(expected)
  })
})
