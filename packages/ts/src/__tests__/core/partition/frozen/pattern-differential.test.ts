import { describe, expect, it } from 'vitest'
import { type CompositePartition, createCompositePartition } from '../../../../core/partition/composite'
import { createFrozenSegment, createSharedFrozenSegment, freezeSegmentShared } from '../../../../core/partition/frozen'
import { mergeFrozenSegments } from '../../../../core/partition/frozen/merge'
import type { SegmentPayload } from '../../../../core/partition/segment-payload'
import { createPatternWorkMeter } from '../../../../core/pattern-index/work-meter'
import type { AnyDocument, SchemaDefinition } from '../../../../types/schema'
import { referenceIds } from '../../../filters/pattern/fixtures'
import {
  changedPatternFields,
  type Random,
  randomDocument,
  randomProbe,
  seededRandom,
  valuesOf,
} from '../../../filters/pattern/random-corpus'
import { english } from '../../partition-index/fixtures'

const SEEDS = [3, 11, 2_024, 31_337, 77_777]
const ROUNDS = 5
const INSERTS_PER_ROUND = 50
const PROBES_PER_CHECK = 60
const FIELDS = ['code', 'tags', 'title'] as const

const schema: SchemaDefinition = {
  body: 'string',
  rank: 'number',
  code: 'verbatim',
  tags: 'verbatim[]',
  title: 'string:pattern',
}

function freezeShared(payload: SegmentPayload, documents: AnyDocument[]) {
  const snapshot = freezeSegmentShared(payload, documents)
  return snapshot === null ? createFrozenSegment(payload, documents) : createSharedFrozenSegment(snapshot)
}

function expectReference(
  composite: CompositePartition,
  random: Random,
  documents: Map<string, AnyDocument>,
  stage: string,
) {
  const current = [...documents.values()]
  for (let probe = 0; probe < PROBES_PER_CHECK; probe++) {
    const field = FIELDS[probe % FIELDS.length]
    const filter = randomProbe(random, valuesOf(current, field))
    const found = [...composite.applyFilters({ fields: { [field]: filter } }, schema, createPatternWorkMeter())].sort()
    expect(found, `${stage} ${field} ${JSON.stringify(filter)}`).toEqual(referenceIds(current, field, filter))
  }
}

function rewrite(composite: CompositePartition, random: Random, documents: Map<string, AnyDocument>): void {
  for (const [id, document] of [...documents]) {
    const roll = random()
    if (roll < 0.12) {
      composite.remove(id, schema, english)
      documents.delete(id)
    } else if (roll < 0.35) {
      const changed = changedPatternFields(random, document)
      composite.update(id, changed, schema, english)
      documents.set(id, changed)
    }
  }
}

function compactFrozen(composite: CompositePartition): void {
  const segmentIds = composite.frozenSegmentSizes().map(size => size.segmentId)
  if (segmentIds.length < 2) return
  const merged = mergeFrozenSegments(composite.frozenSegmentsById(segmentIds))
  if (merged !== null) composite.swapFrozenSegments(segmentIds, createSharedFrozenSegment(merged))
}

describe('a pattern test on a partition of frozen segments and a growing tail', () => {
  it.each(SEEDS)('returns exactly the reference documents as segments freeze, change, and merge (seed %i)', seed => {
    const random = seededRandom(seed)
    const composite = createCompositePartition(0)
    const documents = new Map<string, AnyDocument>()

    for (let round = 0; round < ROUNDS; round++) {
      for (let at = 0; at < INSERTS_PER_ROUND; at++) {
        const document = randomDocument(random, `d${round}-${String(at).padStart(3, '0')}`)
        composite.insert(String(document.id), document, schema, english)
        documents.set(String(document.id), document)
      }
      expectReference(composite, random, documents, `round ${round} growing`)

      expect(composite.freezeLiveTail(round % 2 === 0 ? freezeShared : createFrozenSegment)).not.toBeNull()
      expectReference(composite, random, documents, `round ${round} frozen`)

      rewrite(composite, random, documents)
      expectReference(composite, random, documents, `round ${round} rewritten`)

      if (round % 2 === 1) {
        compactFrozen(composite)
        expect(composite.frozenSegmentCount()).toBe(1)
        expectReference(composite, random, documents, `round ${round} merged`)
      }
    }
  })
})
