import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import type { NarsilConfig } from '../../../types/config'
import { decodedPayload } from '../../e2e/portability/archive-oracle'

it.each(['snapshot', 'wal'] as const)('keeps the %s size through a restart after cleanup fails', async tier => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-size-cleanup-restart-'))
  const cleanupTarget = join(directory, 'docs/snapshot')
  const config: NarsilConfig = {
    ...(tier === 'snapshot' ? { persistence: createFilesystemPersistence({ directory }) } : {}),
    durability: {
      ...(tier === 'snapshot' ? { tier: 'snapshot' } : { directory, mode: 'sync' }),
      checkpointIntervalMs: 0,
      checkpointMutationThreshold: 1_000_000,
    },
    workers: { enabled: false },
    lifecycle: {},
  }
  let engine: Narsil | null = null
  try {
    engine = await createNarsil(config)
    await engine.createIndex('docs', { schema: { title: 'string' } })
    await engine.insert('docs', { title: 'retained record' }, 'retained')
    await engine.checkpoint('docs')
    const previous = engine.getStats('docs').savedBytes
    await engine.insert('docs', { title: 'additional searchable record '.repeat(100) }, 'additional')
    await mkdir(cleanupTarget)
    await expect(engine.checkpoint('docs')).rejects.toMatchObject({ code: 'PERSISTENCE_DELETE_FAILED' })
    await rm(cleanupTarget, { recursive: true })
    const manifest = decodedPayload(await readFile(join(directory, 'docs/manifest')))
    const partitions = manifest.partitions as Array<{ segments: Array<{ key: string }> }>
    let expected = 0
    for (const partition of partitions) {
      for (const segment of partition.segments) expected += (await stat(join(directory, segment.key))).size
    }
    expect(expected).not.toBe(previous)
    expect(engine.getStats('docs').savedBytes).toBe(expected)
    await engine.shutdown()
    engine = await createNarsil(config)
    expect(engine.listIndexes()).toEqual([expect.objectContaining({ name: 'docs', state: 'closed' })])
    expect(engine.getStats('docs').savedBytes).toBe(expected)
    expect(await engine.get('docs', 'additional')).toEqual({ title: 'additional searchable record '.repeat(100) })
    expect(engine.getStats('docs').savedBytes).toBe(expected)
  } finally {
    await engine?.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
