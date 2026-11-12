import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { bytesOf, decodedPayload, readTar, resealed, writeTar } from '../../e2e/portability/archive-oracle'

it('rejects an archive with a false segment count or reclaims its removed documents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-rewrite-manifest-count-'))
  let engine: Narsil | null = null
  const config = {
    durability: { directory, checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000 },
    workers: { enabled: false },
  }
  try {
    engine = await createNarsil(config)
    await engine.createIndex('docs', { schema: { title: 'string' } })
    await engine.insertBatch(
      'docs',
      Array.from({ length: 100 }, (_, at) => ({
        id: `record-${at}`,
        title: `searchable retained document ${at} `.repeat(100),
      })),
    )
    const entries = readTar(await bytesOf(await engine.snapshot('docs')))
    const malformed = writeTar(
      entries.map(entry =>
        entry.name !== 'manifest'
          ? entry
          : {
              ...entry,
              data: resealed(entry.data, payload => {
                const partitions = payload.partitions as Array<{ segments: Array<{ docCount: number }> }>
                for (const partition of partitions) for (const segment of partition.segments) segment.docCount = 0
                return payload
              }),
            },
      ),
    )
    try {
      await engine.restore('docs', malformed)
    } catch (error) {
      expect(error).toMatchObject({ code: 'PERSISTENCE_LOAD_FAILED' })
      return
    }
    expect(await engine.countDocuments('docs')).toBe(100)
    const before = engine.getStats('docs').savedBytes ?? 0
    const removed = Array.from({ length: 21 }, (_, at) => `record-${at}`)
    await engine.removeBatch('docs', removed)
    for (let at = 0; at < 4; at++) await engine.checkpoint('docs')
    await engine.shutdown()
    engine = await createNarsil(config)
    expect(await engine.countDocuments('docs')).toBe(79)
    for (const id of removed) expect(await engine.get('docs', id)).toBeUndefined()
    const manifest = decodedPayload(await readFile(join(directory, 'docs/manifest')))
    const partitions = manifest.partitions as Array<{ segments: Array<{ key: string }> }>
    let bytes = 0
    for (const partition of partitions) {
      for (const segment of partition.segments) bytes += (await stat(join(directory, segment.key))).size
    }
    expect(engine.getStats('docs').savedBytes).toBe(bytes)
    expect(bytes).toBeLessThan(before)
  } finally {
    await engine?.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
