import { describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex, partitionStateOf } from '../../../core/partition'
import { createCompositePartition } from '../../../core/partition/composite'
import { applyPartitionFilters } from '../../../core/partition/filters'
import {
  createFrozenSegment,
  createSharedFrozenSegment,
  type FrozenSegment,
  freezeSegmentShared,
} from '../../../core/partition/frozen'
import { mergeFrozenSegments } from '../../../core/partition/frozen/merge'
import type { PartitionReadState } from '../../../core/partition/read-state'
import { buildSegmentPayload } from '../../../core/partition/segment-builder'
import type { SegmentPayload } from '../../../core/partition/segment-payload'
import { createPatternWorkMeter } from '../../../core/pattern-index/work-meter'
import { flattenSchema } from '../../../schema/validator'
import type { FilterExpression } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'
import { afterChurn, churnOf, productCorpus, SCHEMA } from '../../e2e/filters/corpus'
import { expectAgreesWithOracle } from '../../e2e/filters/harness'
import { valueAt } from '../../e2e/filters/oracle'
import { fieldProbes, randomExpression } from '../../e2e/filters/probes'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { english } from '../partition-index/fixtures'

type Answer = (filters: FilterExpression) => string[]

const CORPUS_SIZE = 900
const BATCHES = 3
const PROBES = 500
const EXPRESSIONS = 150

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort()
}

function frozenAnswer(segment: FrozenSegment): Answer {
  return filters => sorted(applyPartitionFilters(segment, filters, SCHEMA, createPatternWorkMeter()))
}

function documentsOf(payload: SegmentPayload, byId: ReadonlyMap<string, AnyDocument>): AnyDocument[] {
  return payload.docIds.map(docId => {
    const document = byId.get(docId)
    if (document === undefined) throw new Error(`The corpus holds no document "${docId}"`)
    return document
  })
}

function batchSegments(documents: readonly AnyDocument[]): FrozenSegment[] {
  const size = Math.ceil(documents.length / BATCHES)
  return Array.from({ length: BATCHES }, (_, batch) => {
    const slice = documents.slice(batch * size, (batch + 1) * size)
    const payload = buildSegmentPayload(
      slice.map(document => ({ docId: String(document.id), document })),
      SCHEMA,
      english,
      undefined,
      true,
    )
    return createFrozenSegment(payload, slice)
  })
}

function withRetouchedFields(document: AnyDocument, at: number): AnyDocument {
  const retouched: AnyDocument = { ...document, sizes: at % 2 === 0 ? [] : [7, 7], colours: ['red'], price: null }
  if (at % 3 === 0) delete retouched.flags
  if (at % 3 === 1) retouched.location = { lat: -89.5, lon: 179.5 }
  return retouched
}

function storageAnswers(): {
  current: AnyDocument[]
  answers: Array<[string, Answer]>
  states: Array<[string, PartitionReadState]>
} {
  const loaded = productCorpus(CORPUS_SIZE, 71)
  const churn = churnOf(loaded, 72)
  const churned = afterChurn(loaded, churn)
  const retouches = churned
    .filter((_, at) => at % 9 === 0)
    .map((document, at) => ({ docId: String(document.id), document: withRetouchedFields(document, at) }))
  const current = afterChurn(churned, { updates: retouches, removals: [] })
  const byId = new Map(current.map(document => [String(document.id), document]))

  const live = createPartitionIndex(0)
  for (const document of loaded) live.insert(String(document.id), document, SCHEMA, english)
  for (const { docId, document } of churn.updates) live.update(docId, document, SCHEMA, english)
  for (const docId of churn.removals) live.remove(docId, SCHEMA, english)
  for (const { docId, document } of retouches) live.update(docId, document, SCHEMA, english)
  const liveAnswer: Answer = filters => sorted(live.applyFilters(filters, SCHEMA, createPatternWorkMeter()))

  const composite = createCompositePartition(0)
  for (const segment of batchSegments(loaded)) composite.attachFrozenSegment(segment)
  for (const { docId, document } of churn.updates) composite.update(docId, document, SCHEMA, english)
  for (const docId of churn.removals) composite.remove(docId, SCHEMA, english)
  for (const { docId, document } of retouches) composite.update(docId, document, SCHEMA, english)

  const payload = live.encodeSegment()
  const payloadDocuments = documentsOf(payload, byId)
  const thawed = createPartitionIndex(0)
  thawed.mergeSegmentPayload(payload, payloadDocuments)
  const restored: PartitionIndex = createPartitionIndex(0)
  restored.deserialize(live.serialize('products', 1, 'english', SCHEMA), SCHEMA)

  const answers: Array<[string, Answer]> = [
    ['a live partition after updates and removals', liveAnswer],
    [
      'batch segments with tombstones beside a live tail',
      filters => sorted(composite.applyFilters(filters, SCHEMA, createPatternWorkMeter())),
    ],
    ['a segment frozen from the live partition', frozenAnswer(createFrozenSegment(payload, payloadDocuments))],
    [
      'a segment read back into a live partition',
      filters => sorted(thawed.applyFilters(filters, SCHEMA, createPatternWorkMeter())),
    ],
    [
      'a partition restored from its snapshot',
      filters => sorted(restored.applyFilters(filters, SCHEMA, createPatternWorkMeter())),
    ],
  ]
  const shared = freezeSegmentShared(payload, payloadDocuments)
  if (shared !== null)
    answers.push(['a segment shared with worker copies', frozenAnswer(createSharedFrozenSegment(shared))])
  const merged = mergeFrozenSegments(batchSegments(current))
  if (merged !== null) answers.push(['batch segments merged into one', frozenAnswer(createSharedFrozenSegment(merged))])
  const states: Array<[string, PartitionReadState]> = [
    ['the live partition', partitionStateOf(live)],
    ['the thawed partition', partitionStateOf(thawed)],
    ['the restored partition', partitionStateOf(restored)],
    ['the frozen segment', createFrozenSegment(payload, payloadDocuments)],
  ]
  return { current, answers, states }
}

describe('a filter answered from every way that a partition holds its documents', () => {
  const { current, answers, states } = storageAnswers()

  function expectEveryStorageAgrees(filters: FilterExpression): number {
    const [, reference] = answers[0]
    const expected = reference(filters)
    const decided = expectAgreesWithOracle(current, filters, expected)
    for (const [label, answer] of answers.slice(1)) {
      expect(answer(filters), `${label} ${JSON.stringify(filters)}`).toEqual(expected)
    }
    return decided
  }

  it('matches exactly the documents that the independent oracle accepts, for every field test', () => {
    let decided = 0
    for (const { field, filter } of fieldProbes(PROBES, 73)) {
      decided += expectEveryStorageAgrees({ fields: { [field]: filter } } as FilterExpression)
    }
    expect(decided).toBeGreaterThan(PROBES * 100)
  }, 120_000)

  it('keeps one size entry for each document that holds a field, after updates and removals', () => {
    for (const [label, state] of states) {
      for (const field of Object.keys(flattenSchema(SCHEMA))) {
        const holders = current.filter(document => {
          const value = valueAt(document, field)
          return value !== undefined && value !== null
        })
        expect(state.sizeIndexes.get(field)?.count() ?? 0, `${label} ${field}`).toBe(holders.length)
      }
    }
  })

  it('matches exactly the documents that the independent oracle accepts, for nested expressions', () => {
    const random = seededRandom(74)
    for (let at = 0; at < EXPRESSIONS; at++) expectEveryStorageAgrees(randomExpression(random, 3))
  }, 120_000)
})
