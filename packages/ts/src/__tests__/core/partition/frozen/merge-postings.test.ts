import { describe, expect, it } from 'vitest'
import { createFrozenSegment } from '../../../../core/partition/frozen'
import { mergePostings, type SegmentRemap } from '../../../../core/partition/frozen/merge-postings'
import { buildSegmentPayload, type SegmentDocument } from '../../../../core/partition/segment-builder'
import type { SegmentPayload } from '../../../../core/partition/segment-payload'
import { english } from '../../../../languages/english'
import type { SchemaDefinition } from '../../../../types/schema'

const SCHEMA: SchemaDefinition = { title: 'string', body: 'string' }

function documents(from: number, count: number): SegmentDocument[] {
  const words = ['trail', 'road', 'shoes', 'running', 'runner', 'café', 'quartz', 'copper']
  return Array.from({ length: count }, (_, i) => {
    const n = from + i
    return {
      docId: `doc${n}`,
      document: {
        title: `${words[n % words.length]} ${words[(n * 3) % words.length]} shoes`,
        body: `${words[(n * 5) % words.length]} running ${words[(n * 7) % words.length]} running`,
      },
    }
  })
}

function postingsOf(
  payload: Pick<SegmentPayload, 'tokens' | 'postingOffsets' | 'postingDocIds'>,
  source: PostingSource,
) {
  const byToken = new Map<string, unknown>()
  for (let t = 0; t < payload.tokens.length; t++) {
    const rows: unknown[] = []
    for (let p = payload.postingOffsets[t]; p < payload.postingOffsets[t + 1]; p++) {
      const positions =
        source.positionOffsets === null || source.positionValues === null
          ? null
          : [...source.positionValues.subarray(source.positionOffsets[p], source.positionOffsets[p + 1])]
      rows.push([payload.postingDocIds[p], source.postingFrequencies[p], source.postingFieldIndices[p], positions])
    }
    byToken.set(payload.tokens[t], rows)
  }
  return byToken
}

type PostingSource = Pick<
  SegmentPayload,
  'postingFrequencies' | 'postingFieldIndices' | 'positionOffsets' | 'positionValues'
>

function inputsFor(chunks: SegmentDocument[][], trackPositions: boolean): SegmentRemap[] {
  let base = 0
  return chunks.map(chunk => {
    const payload = buildSegmentPayload(chunk, SCHEMA, english, undefined, trackPositions)
    const remap = Int32Array.from(chunk, (_, i) => base + i)
    base += chunk.length
    return {
      segment: createFrozenSegment(
        payload,
        chunk.map(entry => entry.document),
      ),
      remap,
      fieldIndexRemap: Uint8Array.from(payload.fieldNames, (_, i) => i),
    }
  })
}

describe('merging the postings of frozen segments', () => {
  for (const trackPositions of [true, false]) {
    it(`gives the postings that one segment over every document holds, positions ${trackPositions ? 'on' : 'off'}`, () => {
      const chunks = [documents(0, 40), documents(40, 25), documents(65, 1)]
      const whole = buildSegmentPayload(chunks.flat(), SCHEMA, english, undefined, trackPositions)

      const merged = mergePostings(inputsFor(chunks, trackPositions))

      expect(postingsOf(merged, merged)).toEqual(postingsOf(whole, whole))
      expect(merged.docFrequencies).toEqual(whole.docFrequencies)
      expect([...merged.tokens]).toEqual([...merged.tokens].sort())
    })
  }

  it('drops the postings of a document that the merge leaves out', () => {
    const chunks = [documents(0, 10), documents(10, 10)]
    const inputs = inputsFor(chunks, true)
    inputs[0].remap[3] = -1
    const kept = chunks.flat().filter(entry => entry.docId !== 'doc3')
    const whole = buildSegmentPayload(kept, SCHEMA, english, undefined, true)
    for (let ordinal = 4; ordinal < 10; ordinal++) inputs[0].remap[ordinal] = ordinal - 1
    for (let ordinal = 0; ordinal < 10; ordinal++) inputs[1].remap[ordinal] = 9 + ordinal

    const merged = mergePostings(inputs)

    expect(postingsOf(merged, merged)).toEqual(postingsOf(whole, whole))
    expect(merged.docFrequencies).toEqual(whole.docFrequencies)
  })
})
