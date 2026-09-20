import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../../core/partition'
import { buildSegmentPayload, type SegmentDocument } from '../../../core/partition/segment-builder'
import type { SegmentPayload } from '../../../core/partition/segment-payload'
import type { PartitionInsertOptions } from '../../../core/partition/utils'
import { ErrorCodes, NarsilError } from '../../../errors'
import { english } from '../../../languages/english'
import type { SchemaDefinition } from '../../../types/schema'

const SCHEMA: SchemaDefinition = {
  title: 'string',
  tags: 'string[]',
  price: 'number',
  ratings: 'number[]',
  inStock: 'boolean',
  flags: 'boolean[]',
  category: 'enum',
  labels: 'enum[]',
  location: 'geopoint',
  maker: { name: 'string', country: 'enum' },
}

const DOCUMENTS: SegmentDocument[] = [
  {
    docId: 'p1',
    document: {
      title: "The runner's running shoes were running fast and the shoes fitted",
      tags: ['trail running', 'road shoes', ''],
      price: 129.5,
      ratings: [4, 5, 4],
      inStock: true,
      flags: [true, false],
      category: 'shoes',
      labels: ['sale', 'new'],
      location: { lat: 5.6037, lon: -0.187 },
      maker: { name: 'Accra Runners Limited', country: 'GH' },
    },
  },
  { docId: 'p2', document: { title: 'the and of', tags: [], price: 0, inStock: false, category: 'misc' } },
  { docId: 'p3', document: { title: '', maker: { name: 'Quiet makers making quietly' } } },
  { docId: 'p4', document: { price: -3, labels: ['sale'], location: { lat: -33.9, lon: 18.4 } } },
  {
    docId: 'p5',
    document: {
      title: 'Shoes shoes SHOES: café crème brûlée for runners',
      tags: ['running', 'running', 'cafés'],
      ratings: [],
      category: 'shoes',
      maker: { country: 'FR' },
    },
  },
  { docId: 'p6', document: {} },
]

function throughTheLivePartition(
  documents: readonly SegmentDocument[],
  options: PartitionInsertOptions | undefined,
  trackPositions: boolean,
): SegmentPayload {
  const segment = createPartitionIndex(0, trackPositions)
  segment.beginBatch()
  for (const entry of documents) segment.insert(entry.docId, entry.document, SCHEMA, english, options)
  segment.endBatch()
  return segment.encodeSegment()
}

const WORDS_BY_SPACE = {
  tokenize(text: string) {
    return text
      .split(' ')
      .filter(word => word.length > 0)
      .map((word, position) => ({ token: word.toLowerCase(), position }))
  },
}

describe('building a segment without a live partition', () => {
  const variants: Array<[string, PartitionInsertOptions | undefined, boolean]> = [
    ['with positions', undefined, true],
    ['without positions', undefined, false],
    ['with surface forms', { collectSurfaces: true }, true],
    ['with surface forms and no positions', { collectSurfaces: true }, false],
    ['with a stop word list of its own', { stopWordOverride: new Set(['shoes']) }, true],
    ['with a stop word function', { stopWordOverride: defaults => new Set([...defaults, 'fast']) }, true],
    ['with a custom tokenizer', { customTokenizer: WORDS_BY_SPACE, collectSurfaces: true }, true],
    ['with validation off', { validate: false }, true],
  ]

  for (const [label, options, trackPositions] of variants) {
    it(`writes the payload that the live partition writes, ${label}`, () => {
      expect(buildSegmentPayload(DOCUMENTS, SCHEMA, english, options, trackPositions)).toEqual(
        throughTheLivePartition(DOCUMENTS, options, trackPositions),
      )
    })
  }

  it('writes the payload that the live partition writes for no documents', () => {
    expect(buildSegmentPayload([], SCHEMA, english, undefined, true)).toEqual(
      throughTheLivePartition([], undefined, true),
    )
  })

  it('caps a term frequency where the live partition caps it', () => {
    const repeated: SegmentDocument[] = [{ docId: 'long', document: { title: 'shoe '.repeat(70_000) } }]
    const payload = buildSegmentPayload(repeated, SCHEMA, english, undefined, false)
    expect(payload).toEqual(throughTheLivePartition(repeated, undefined, false))
    expect(payload.postingFrequencies[0]).toBe(65_535)
  })

  it('refuses a document id that appears twice in the batch', () => {
    const twice = [DOCUMENTS[0], DOCUMENTS[1], DOCUMENTS[0]]
    expect(() => buildSegmentPayload(twice, SCHEMA, english, undefined, true)).toThrowError(
      expect.objectContaining({ code: ErrorCodes.DOC_ALREADY_EXISTS }),
    )
  })

  it('refuses the document that the live partition refuses, with the same error', () => {
    const invalid: SegmentDocument[] = [{ docId: 'bad', document: { price: 'twelve' } }]
    let fromLive: unknown
    try {
      throughTheLivePartition(invalid, undefined, true)
    } catch (error) {
      fromLive = error
    }
    expect(fromLive).toBeInstanceOf(NarsilError)
    expect(() => buildSegmentPayload(invalid, SCHEMA, english, undefined, true)).toThrowError(
      expect.objectContaining({ code: (fromLive as NarsilError).code }),
    )
  })

  it('applies the strict check where the caller asks for it', () => {
    const extra: SegmentDocument[] = [{ docId: 'extra', document: { title: 'Shoes', colour: 'red' } }]
    expect(() => buildSegmentPayload(extra, SCHEMA, english, { strict: true }, true)).toThrow(NarsilError)
    expect(buildSegmentPayload(extra, SCHEMA, english, undefined, true).documentCount).toBe(1)
  })
})
