import { expect } from 'vitest'
import type { Narsil } from '../../types/engine'

const FNV_OFFSET_BASIS = 0x811c9dc5n
const FNV_PRIME = 0x01000193n
const UINT32_MASK = 0xffffffffn

export function fnv1aOf(docId: string): number {
  let hash = FNV_OFFSET_BASIS
  for (const byte of new TextEncoder().encode(docId)) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT32_MASK
  return Number(hash)
}

export function countsByPartition(ids: Iterable<string>, partitionCount: number): number[] {
  const counts = new Array<number>(partitionCount).fill(0)
  for (const id of ids) counts[fnv1aOf(id) % partitionCount] += 1
  return counts
}

export function idsFrom(prefix: string, from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, at) => `${prefix}${from + at}`)
}

export async function expectLayout(
  engine: Narsil,
  indexName: string,
  titles: ReadonlyMap<string, string>,
  partitionCount: number,
): Promise<void> {
  expect(await engine.countDocuments(indexName)).toBe(titles.size)
  const stats = engine.getPartitionStats(indexName)
  expect(stats.map(partition => partition.partitionId)).toEqual(Array.from({ length: partitionCount }, (_, at) => at))
  expect(stats.map(partition => partition.documentCount)).toEqual(countsByPartition(titles.keys(), partitionCount))
  for (const [id, title] of titles) expect((await engine.get(indexName, id))?.title, id).toBe(title)
}
