import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import { expectLayout } from '../../engine/partition-layout-oracle'
import { bytesOf, decodedPayload, readTar, resealed, withEntry, writeTar } from './archive-oracle'
import { temporaryRoots } from './harness'

const INDEX = 'shelf'
const PARTITION_ID_LIMIT = 65_536
const LARGEST_UINT32 = 4_294_967_295
const DOCUMENTS = 120

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function track(engine: Narsil): Narsil {
  engines.push(engine)
  return engine
}

function documentAt(at: number): [string, AnyDocument] {
  return [`book-${at}`, { title: `lantern harbour volume ${at}` }]
}

function titlesUpTo(count: number): Map<string, string> {
  return new Map(Array.from({ length: count }, (_, at) => [`book-${at}`, `lantern harbour volume ${at}`]))
}

async function savedIndex(maxPartitions: number, partitionCount: number): Promise<string> {
  const directory = await roots.make('narsil-partition-limits-')
  const engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
  await engine.createIndex(INDEX, { schema: { title: 'string' }, partitions: { maxPartitions } })
  for (let at = 0; at < DOCUMENTS; at += 1) {
    const [id, document] = documentAt(at)
    await engine.insert(INDEX, document, id)
  }
  if (partitionCount !== maxPartitions) await engine.rebalance(INDEX, partitionCount)
  await engine.checkpoint(INDEX)
  await engine.shutdown()
  return directory
}

async function rewriteSaved(
  directory: string,
  file: 'meta' | 'manifest',
  change: (payload: Record<string, unknown>) => unknown,
): Promise<void> {
  const path = join(directory, INDEX, file)
  await writeFile(path, resealed(new Uint8Array(await readFile(path)), change))
}

function openDurable(directory: string): Promise<Narsil> {
  return createNarsil({ workers: { enabled: false }, durability: { directory } }).then(track)
}

function withPartitionLimit(raw: Record<string, unknown>, maxPartitions: number): Record<string, unknown> {
  return {
    ...raw,
    partition_limits: { ...(raw.partition_limits as Record<string, unknown>), max_partitions: maxPartitions },
  }
}

function withEmptyPartitionNumbered(raw: Record<string, unknown>, partitionId: number): Record<string, unknown> {
  const listed = raw.partitions as Array<Record<string, unknown>>
  return { ...raw, partitions: [...listed, { partitionId, nextSegmentId: 0, segments: [] }] }
}

async function archiveOf(maxPartitions: number, partitionCount: number) {
  const engine = track(await createNarsil({ workers: { enabled: false } }))
  await engine.createIndex(INDEX, { schema: { title: 'string' }, partitions: { maxPartitions } })
  for (let at = 0; at < DOCUMENTS; at += 1) {
    const [id, document] = documentAt(at)
    await engine.insert(INDEX, document, id)
  }
  if (partitionCount !== maxPartitions) await engine.rebalance(INDEX, partitionCount)
  return { engine, entries: readTar(await bytesOf(await engine.snapshot(INDEX))) }
}

function withArchiveLimit(raw: Record<string, unknown>, maxPartitions: number): Record<string, unknown> {
  return { ...raw, partitionConfig: { ...(raw.partitionConfig as Record<string, unknown>), maxPartitions } }
}

describe('the limit of 65,536 on maxPartitions', () => {
  it('refuses 65,537 on a new index and on a configuration update, and takes 65,536 as an update', async () => {
    const engine = track(await createNarsil({ workers: { enabled: false } }))

    await expect(
      engine.createIndex('wide', {
        schema: { title: 'string' },
        partitions: { maxPartitions: PARTITION_ID_LIMIT + 1 },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID, details: { maxPartitions: PARTITION_ID_LIMIT + 1 } })
    expect(engine.listIndexes()).toEqual([])

    await engine.createIndex(INDEX, { schema: { title: 'string' } })
    await expect(engine.updatePartitionConfig(INDEX, { maxPartitions: PARTITION_ID_LIMIT + 1 })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    })
    await expect(engine.rebalance(INDEX, 2)).rejects.toMatchObject({ details: { maxPartitions: 1 } })

    await engine.updatePartitionConfig(INDEX, { maxPartitions: PARTITION_ID_LIMIT })
    await expect(engine.rebalance(INDEX, PARTITION_ID_LIMIT + 1)).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      details: { maxPartitions: PARTITION_ID_LIMIT },
    })
  })
})

describe('a saved index that numbers a partition 65,536 or higher', () => {
  it.each([
    PARTITION_ID_LIMIT + 1,
    LARGEST_UINT32,
  ])('refuses metadata that counts %d partitions', async partitionCount => {
    const directory = await savedIndex(2, 2)
    await rewriteSaved(directory, 'meta', raw => ({ ...raw, partition_count: partitionCount }))

    await expect(openDurable(directory)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
      details: { indexName: INDEX, partitionId: partitionCount - 1 },
    })
  })

  it.each([
    PARTITION_ID_LIMIT,
    LARGEST_UINT32,
  ])('refuses a segment manifest that numbers a partition %d', async partitionId => {
    const directory = await savedIndex(2, 2)
    await rewriteSaved(directory, 'manifest', raw => withEmptyPartitionNumbered(raw, partitionId))

    await expect(openDurable(directory)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
      details: { indexName: INDEX, partitionId },
    })
  })

  it.each([PARTITION_ID_LIMIT, LARGEST_UINT32])('refuses an archive that numbers a partition %d', async partitionId => {
    const { engine, entries } = await archiveOf(2, 2)
    const archive = writeTar(
      withEntry(
        entries,
        'manifest',
        resealed(entries[1].data, raw => withEmptyPartitionNumbered(raw, partitionId)),
      ),
    )

    await expect(engine.restore('copy', archive)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
      details: { indexName: 'copy', partitionId },
    })
    expect(engine.listIndexes().map(index => index.name)).toEqual([INDEX])
  })
})

describe('a saved index whose maxPartitions passes a limit', () => {
  it('opens a stored maxPartitions above 65,536 as 65,536', async () => {
    const directory = await savedIndex(2, 2)
    await rewriteSaved(directory, 'meta', raw => withPartitionLimit(raw, 100_000))
    const engine = await openDurable(directory)

    await expectLayout(engine, INDEX, titlesUpTo(DOCUMENTS), 2)
    await expect(engine.rebalance(INDEX, PARTITION_ID_LIMIT + 1)).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      details: { maxPartitions: PARTITION_ID_LIMIT },
    })
    await engine.updatePartitionConfig(INDEX, { watermark: 0.5 })
    const saved = decodedPayload(new Uint8Array(await readFile(join(directory, INDEX, 'meta'))))
    expect(saved.partition_limits).toMatchObject({ max_partitions: PARTITION_ID_LIMIT })
  })

  it('opens an index that holds more partitions than its stored maxPartitions, and holds a later rebalance to it', async () => {
    const directory = await savedIndex(4, 4)
    await rewriteSaved(directory, 'meta', raw => withPartitionLimit(raw, 2))
    const engine = await openDurable(directory)

    await expectLayout(engine, INDEX, titlesUpTo(DOCUMENTS), 4)
    await expect(engine.rebalance(INDEX, 3)).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      details: { targetPartitionCount: 3, maxPartitions: 2 },
    })
    await engine.rebalance(INDEX, 2)
    await expectLayout(engine, INDEX, titlesUpTo(DOCUMENTS), 2)
  })

  it('restores an archive whose maxPartitions passes 65,536 or sits below its partition count', async () => {
    const { engine, entries } = await archiveOf(4, 4)
    const above = writeTar(
      withEntry(
        entries,
        'config',
        resealed(entries[0].data, raw => withArchiveLimit(raw, 100_000)),
      ),
    )
    const below = writeTar(
      withEntry(
        entries,
        'config',
        resealed(entries[0].data, raw => withArchiveLimit(raw, 2)),
      ),
    )

    await engine.restore('above', above)
    await engine.restore('below', below)

    await expectLayout(engine, 'above', titlesUpTo(DOCUMENTS), 4)
    await expect(engine.rebalance('above', PARTITION_ID_LIMIT + 1)).rejects.toMatchObject({
      details: { maxPartitions: PARTITION_ID_LIMIT },
    })
    await expectLayout(engine, 'below', titlesUpTo(DOCUMENTS), 4)
    await expect(engine.rebalance('below', 3)).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      details: { targetPartitionCount: 3, maxPartitions: 2 },
    })
  })
})
