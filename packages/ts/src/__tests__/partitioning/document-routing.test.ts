import { afterEach, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const PARTITIONS = 7
const ID_PIECES = ['a', 'Z', '9', '-', 'é', 'ß', 'Ω', 'ж', '東', '京', '한', '€', '😀', '𝄞', '🧭', 'ǅ']
const DOCUMENTS = 600

const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

function utf8Fnv1a(text: string): number {
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(text)) {
    hash = Number((BigInt((hash ^ byte) >>> 0) * 16777619n) % 4294967296n)
  }
  return hash
}

function idsFrom(seed: number): string[] {
  let state = seed
  const ids: string[] = []
  for (let at = 0; at < DOCUMENTS; at++) {
    let id = ''
    const length = 1 + (at % 9)
    for (let piece = 0; piece < length; piece++) {
      state = (state * 1103515245 + 12345) >>> 0
      id += ID_PIECES[state % ID_PIECES.length]
    }
    ids.push(`${id}${at}`)
  }
  return ids
}

it('routes document IDs that mix one-, two-, three-, and four-byte characters to the partition of their UTF-8 hash', async () => {
  const narsil = await createNarsil({ workers: { enabled: false } })
  engines.push(narsil)
  await narsil.createIndex('routed', { schema: { title: 'string' }, partitions: { maxPartitions: PARTITIONS } })
  const ids = idsFrom(20261109)
  const result = await narsil.insertBatch(
    'routed',
    ids.map(id => ({ id, title: 'routed document' })),
  )
  expect(result.failed).toEqual([])

  const expected = new Array<number>(PARTITIONS).fill(0)
  for (const id of ids) expected[utf8Fnv1a(id) % PARTITIONS]++
  const stats = narsil.getPartitionStats('routed')
  expect(stats.map(partition => partition.documentCount)).toEqual(expected)
  expect(expected.filter(count => count > 0).length).toBe(PARTITIONS)
  expect(utf8Fnv1a('foobar')).toBe(0xbf9cf968)
})
