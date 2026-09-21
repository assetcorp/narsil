import { getHeapStatistics, setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createCompositePartition } from '../../../../core/partition/composite'
import { createFrozenSegment } from '../../../../core/partition/frozen'
import { buildSegmentPayload } from '../../../../core/partition/segment-builder'
import type { AnyDocument, SchemaDefinition } from '../../../../types/schema'
import { english } from '../../partition-index/fixtures'

const MB = 1024 * 1024
const SCHEMA: SchemaDefinition = { text: 'string' }
const SEGMENTS = 8
const DOCUMENTS_PER_SEGMENT = 2_500
const WORDS_PER_DOCUMENT = 40
const VOCABULARY = 20_000

function collectorOfThisThread(): () => void {
  setFlagsFromString('--expose-gc')
  const collect: unknown = runInNewContext('gc')
  setFlagsFromString('--no-expose-gc')
  if (typeof collect !== 'function') throw new Error('the runtime exposes no collector')
  return () => collect()
}

function corpus(segment: number): AnyDocument[] {
  let seed = 1_000 + segment
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  return Array.from({ length: DOCUMENTS_PER_SEGMENT }, (_, i) => {
    const words: string[] = []
    for (let w = 0; w < WORDS_PER_DOCUMENT; w++) words.push(`harbour${Math.floor(next() * VOCABULARY)}`)
    return { id: `s${segment}-d${i}`, text: words.join(' ') }
  })
}

describe('serialising a partition that holds frozen segments', () => {
  it('leaves the frozen segments holding no more memory than before', () => {
    const composite = createCompositePartition(0)
    for (let segment = 0; segment < SEGMENTS; segment++) {
      const documents = corpus(segment)
      const payload = buildSegmentPayload(
        documents.map(document => ({ docId: String(document.id), document })),
        SCHEMA,
        english,
        undefined,
        true,
      )
      composite.attachFrozenSegment(createFrozenSegment(payload, documents))
    }
    const collect = collectorOfThisThread()

    collect()
    const liveBefore = getHeapStatistics().used_heap_size
    const bytes = composite.serializeToBytes('papers', 1, 'english', SCHEMA)
    expect(bytes.byteLength).toBeGreaterThan(MB)
    collect()
    const retained = getHeapStatistics().used_heap_size - liveBefore

    expect(composite.count()).toBe(SEGMENTS * DOCUMENTS_PER_SEGMENT)
    expect(retained).toBeLessThan(16 * MB)
  }, 60_000)
})
