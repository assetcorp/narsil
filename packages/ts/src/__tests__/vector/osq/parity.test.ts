import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  osqEstimate,
  osqLevelProducts,
  osqNarrowPairProducts,
  osqNibbleProducts,
  osqQueryBits,
  osqStagedQueryProducts,
} from '../../../vector/osq/estimate'
import { createOsqScratch, type OsqBits, osqCentroid, osqQuantize } from '../../../vector/osq/quantize'
import {
  osqCodeBytes,
  osqRecordBytes,
  osqStagedQueryBytes,
  packLevels,
  readRecord,
  stageQueryLevels,
  writeRecord,
} from '../../../vector/osq/record'

interface FixtureCode {
  lower: number
  upper: number
  correction: number
  sum: number
  levels: number[]
}

interface Fixture {
  metric: 'cosine'
  dimension: number
  docs: number[][]
  queries: number[][]
  centroid: number[]
  byBits: Record<string, { docs: FixtureCode[]; queries: FixtureCode[]; scores: number[][] }>
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lucene-parity.json', import.meta.url), 'utf8')) as Fixture
const docs = fixture.docs.map(values => Float32Array.from(values))
const queries = fixture.queries.map(values => Float32Array.from(values))
const luceneCentroid = Float32Array.from(fixture.centroid)
const WIDTHS: OsqBits[] = [1, 2, 4, 8]

function levelsEqual(a: Uint8Array, b: number[]): number {
  let equal = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) equal += 1
  return equal / a.length
}

describe('optimised scalar quantization against Lucene', () => {
  it('computes the centroid Lucene computes', () => {
    const centroid = osqCentroid(docs, fixture.dimension, fixture.metric)
    expect(centroid).not.toBeNull()
    if (centroid === null) return
    for (let i = 0; i < fixture.dimension; i++) expect(centroid[i]).toBeCloseTo(luceneCentroid[i], 6)
  })

  it.each(WIDTHS)('quantizes documents and queries to the codes Lucene writes at %i bits', bits => {
    const scratch = createOsqScratch(fixture.dimension)
    const expected = fixture.byBits[String(bits)]
    const queryBits = osqQueryBits(bits)
    for (let d = 0; d < docs.length; d++) {
      const code = osqQuantize(docs[d], luceneCentroid, bits, fixture.metric, scratch)
      expect(levelsEqual(code.levels, expected.docs[d].levels)).toBeGreaterThanOrEqual(bits === 1 ? 1 : 0.98)
      expect(code.lower).toBeCloseTo(expected.docs[d].lower, 4)
      expect(code.upper).toBeCloseTo(expected.docs[d].upper, 4)
      expect(code.correction).toBeCloseTo(expected.docs[d].correction, 4)
    }
    for (let q = 0; q < queries.length; q++) {
      const code = osqQuantize(queries[q], luceneCentroid, queryBits, fixture.metric, scratch)
      expect(levelsEqual(code.levels, expected.queries[q].levels)).toBeGreaterThanOrEqual(0.98)
    }
  })

  it.each(WIDTHS)('estimates the score Lucene estimates at %i bits', bits => {
    const scratch = createOsqScratch(fixture.dimension)
    const expected = fixture.byBits[String(bits)]
    const queryBits = osqQueryBits(bits)
    let centroidDot = 0
    for (let i = 0; i < fixture.dimension; i++) centroidDot += luceneCentroid[i] * luceneCentroid[i]
    const documentCodes = docs.map(doc => osqQuantize(doc, luceneCentroid, bits, fixture.metric, scratch))
    for (let q = 0; q < queries.length; q++) {
      const query = osqQuantize(queries[q], luceneCentroid, queryBits, fixture.metric, scratch)
      for (let d = 0; d < docs.length; d++) {
        const products = osqLevelProducts(documentCodes[d].levels, query.levels)
        const estimate = osqEstimate(
          products,
          documentCodes[d],
          bits,
          query,
          queryBits,
          fixture.dimension,
          centroidDot,
          fixture.metric,
        )
        expect(Math.abs(estimate - expected.scores[q][d])).toBeLessThan(2e-3)
      }
    }
  })

  it.each([1, 2] as const)('sums level products from a packed %i-bit code and a staged query', bits => {
    const scratch = createOsqScratch(fixture.dimension)
    const codeBytes = osqCodeBytes(fixture.dimension, bits)
    const document = osqQuantize(docs[0], luceneCentroid, bits, fixture.metric, scratch)
    const other = osqQuantize(docs[1], luceneCentroid, bits, fixture.metric, scratch)
    const query = osqQuantize(queries[0], luceneCentroid, osqQueryBits(bits), fixture.metric, scratch)
    const documentBytes = new Uint8Array(codeBytes)
    const otherBytes = new Uint8Array(codeBytes)
    const staged = new Uint8Array(osqStagedQueryBytes(fixture.dimension, bits))
    packLevels(document.levels, bits, documentBytes, 0)
    packLevels(other.levels, bits, otherBytes, 0)
    stageQueryLevels(query.levels, bits, staged)
    expect(osqStagedQueryProducts(documentBytes, 0, bits, staged, 0, codeBytes)).toBe(
      osqLevelProducts(document.levels, query.levels),
    )
    expect(osqNarrowPairProducts(documentBytes, 0, otherBytes, 0, bits, codeBytes)).toBe(
      osqLevelProducts(document.levels, other.levels),
    )
  })

  it('sums level products from two packed 4-bit codes', () => {
    const scratch = createOsqScratch(fixture.dimension)
    const codeBytes = osqCodeBytes(fixture.dimension, 4)
    const document = osqQuantize(docs[0], luceneCentroid, 4, fixture.metric, scratch)
    const query = osqQuantize(queries[0], luceneCentroid, 4, fixture.metric, scratch)
    const documentBytes = new Uint8Array(codeBytes)
    const queryBytes = new Uint8Array(codeBytes)
    packLevels(document.levels, 4, documentBytes, 0)
    packLevels(query.levels, 4, queryBytes, 0)
    expect(osqNibbleProducts(documentBytes, 0, queryBytes, 0, codeBytes)).toBe(
      osqLevelProducts(document.levels, query.levels),
    )
  })

  it.each([1, 2, 4] as OsqBits[])('packs level i of a %i-bit code from the lowest bit of its byte upwards', bits => {
    const perByte = 8 / bits
    const levels = new Uint8Array(perByte + 1)
    levels[1] = 2 ** bits - 1
    levels[perByte] = 1
    const bytes = new Uint8Array(osqCodeBytes(levels.length, bits))
    packLevels(levels, bits, bytes, 0)
    expect(Array.from(bytes)).toEqual([(2 ** bits - 1) << bits, 1])
  })

  it.each(WIDTHS)('round-trips a record through its byte layout at %i bits', bits => {
    const scratch = createOsqScratch(fixture.dimension)
    const code = osqQuantize(docs[1], luceneCentroid, bits, fixture.metric, scratch)
    const bytes = new Uint8Array(osqRecordBytes(fixture.dimension, bits) + 8)
    writeRecord(bytes, 8, code, bits)
    const restored = readRecord(bytes, 8, fixture.dimension, bits)
    expect(Array.from(restored.levels)).toEqual(Array.from(code.levels))
    expect(restored.lower).toBe(Math.fround(code.lower))
    expect(restored.upper).toBe(Math.fround(code.upper))
    expect(restored.correction).toBe(Math.fround(code.correction))
    expect(restored.sum).toBe(code.sum)
  })
})
