import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorMetric } from '../brute-force'
import type { NumberedGraphParts, NumberedHnswGraph } from '../hnsw'
import { EARLIER_RELEASE_MIN_M, MAX_M, MIN_M } from '../hnsw/constants'
import { codesOf, VECTOR_INDEX_PART_VECTORS, type VectorIndexCodes } from './payload'

export const VECTOR_FILE_PAYLOAD_VERSION = 1
export const VECTOR_GRAPH_PAYLOAD_VERSION = 1
export const VECTOR_GRAPH_PART_PAYLOAD_VERSION = 2
export const VECTOR_GRAPH_PART_VECTORS = 16_384
export const VECTOR_FILE_MAX_VECTORS = VECTOR_INDEX_PART_VECTORS

export interface VectorFilePayload {
  v: typeof VECTOR_FILE_PAYLOAD_VERSION
  fieldName: string
  dimension: number
  docIds: string[]
  codes: VectorIndexCodes | null
  vectors: Uint8Array
}

export interface VectorGraphPayload {
  v: typeof VECTOR_GRAPH_PAYLOAD_VERSION
  fieldName: string
  graphs: NumberedHnswGraph[]
}

export interface VectorGraphPartPayload {
  v: typeof VECTOR_GRAPH_PART_PAYLOAD_VERSION
  fieldName: string
  graphs: NumberedHnswGraph[]
}

export interface VectorGraphParts {
  fieldName: string
  graphs: NumberedGraphParts[]
}

const METRICS: readonly VectorMetric[] = ['cosine', 'dotProduct', 'euclidean']

function invalid(payload: string, message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Invalid ${payload} payload: ${message}`, details)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIntegerUpTo(value: unknown, highest: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= highest
}

function requireVersion(payload: string, found: unknown, expected: number): void {
  if (found === expected) return
  throw new NarsilError(
    ErrorCodes.ENVELOPE_VERSION_MISMATCH,
    `This ${payload} payload was written in layout ${String(found)}, and this build reads layout ${expected} alone`,
    { version: found },
  )
}

export function decodeVectorFilePayload(raw: unknown): VectorFilePayload {
  const name = 'vector file'
  if (!isRecord(raw)) invalid(name, 'payload must be a map')
  requireVersion(name, raw.v, VECTOR_FILE_PAYLOAD_VERSION)
  if (typeof raw.fieldName !== 'string') invalid(name, 'fieldName must be a string')
  if (!isIntegerUpTo(raw.dimension, 0xffff) || raw.dimension === 0) invalid(name, 'dimension must be a positive uint16')
  if (!Array.isArray(raw.docIds) || !raw.docIds.every(docId => typeof docId === 'string')) {
    invalid(name, 'docIds must be a list of strings')
  }
  if (raw.docIds.length > VECTOR_FILE_MAX_VECTORS) {
    invalid(name, `a file holds at most ${VECTOR_FILE_MAX_VECTORS} vectors`, { count: raw.docIds.length })
  }
  if (!(raw.vectors instanceof Uint8Array)) invalid(name, 'vectors must be bytes')
  if (raw.vectors.byteLength !== raw.docIds.length * raw.dimension * 4) {
    invalid(name, 'vectors must hold dimension float32 components per document', {
      count: raw.docIds.length,
      bytes: raw.vectors.byteLength,
    })
  }
  return {
    v: VECTOR_FILE_PAYLOAD_VERSION,
    fieldName: raw.fieldName,
    dimension: raw.dimension,
    docIds: raw.docIds,
    codes: codesOf(raw.codes, raw.dimension, raw.docIds.length),
    vectors: raw.vectors,
  }
}

function isMetric(value: unknown): value is VectorMetric {
  return METRICS.some(metric => metric === value)
}

function decodeNumberedGraph(raw: unknown, minimumM: number): NumberedHnswGraph {
  const name = 'vector graph'
  if (!isRecord(raw)) invalid(name, 'each graph must be a map')
  const entryPoint = raw.entryPoint ?? null
  if (entryPoint !== null && !isIntegerUpTo(entryPoint, 0xffff_ffff))
    invalid(name, 'entryPoint must be a uint32 or nil')
  if (!isIntegerUpTo(raw.maxLayer, 0xff)) invalid(name, 'maxLayer must be a uint8')
  if (!isIntegerUpTo(raw.m, MAX_M) || raw.m < minimumM) {
    invalid(name, `m must be a whole number from ${minimumM} to ${MAX_M}`)
  }
  if (!isIntegerUpTo(raw.efConstruction, 0xffff)) invalid(name, 'efConstruction must be a uint16')
  if (!isMetric(raw.metric)) invalid(name, 'metric must name a supported metric', { metric: raw.metric })
  if (!(raw.levels instanceof Uint8Array)) invalid(name, 'levels must be bytes')
  if (!(raw.neighbours instanceof Uint8Array)) invalid(name, 'neighbours must be bytes')
  const graph: NumberedHnswGraph = {
    entryPoint,
    maxLayer: raw.maxLayer,
    m: raw.m,
    efConstruction: raw.efConstruction,
    metric: raw.metric,
    levels: raw.levels,
    neighbours: raw.neighbours,
  }
  const shuffledBuildCount = raw.shuffledBuildCount ?? null
  if (shuffledBuildCount === null) return graph
  if (!isIntegerUpTo(shuffledBuildCount, 0xffff_ffff)) invalid(name, 'shuffledBuildCount must be a uint32')
  const calibratedMeanLength = raw.calibratedMeanLength ?? null
  if (calibratedMeanLength === null) return { ...graph, shuffledBuildCount }
  if (typeof calibratedMeanLength !== 'number' || !Number.isFinite(calibratedMeanLength) || calibratedMeanLength < 0) {
    invalid(name, 'calibratedMeanLength must be a finite float64 of at least 0')
  }
  return { ...graph, shuffledBuildCount, calibratedMeanLength }
}

export function decodeVectorGraphPayload(raw: unknown): VectorGraphPayload {
  const name = 'vector graph'
  if (!isRecord(raw)) invalid(name, 'payload must be a map')
  requireVersion(name, raw.v, VECTOR_GRAPH_PAYLOAD_VERSION)
  if (typeof raw.fieldName !== 'string') invalid(name, 'fieldName must be a string')
  if (!Array.isArray(raw.graphs)) invalid(name, 'graphs must be a list')
  return {
    v: VECTOR_GRAPH_PAYLOAD_VERSION,
    fieldName: raw.fieldName,
    graphs: raw.graphs.map(graph => decodeNumberedGraph(graph, EARLIER_RELEASE_MIN_M)),
  }
}

export function decodeVectorGraphPartPayload(raw: unknown): VectorGraphPartPayload {
  const name = 'vector graph part'
  if (!isRecord(raw)) invalid(name, 'payload must be a map')
  requireVersion(name, raw.v, VECTOR_GRAPH_PART_PAYLOAD_VERSION)
  if (typeof raw.fieldName !== 'string') invalid(name, 'fieldName must be a string')
  if (!Array.isArray(raw.graphs)) invalid(name, 'graphs must be a list')
  return {
    v: VECTOR_GRAPH_PART_PAYLOAD_VERSION,
    fieldName: raw.fieldName,
    graphs: raw.graphs.map(graph => decodeNumberedGraph(graph, MIN_M)),
  }
}

function sameGraphHeader(a: NumberedHnswGraph, b: NumberedHnswGraph): boolean {
  return (
    a.entryPoint === b.entryPoint &&
    a.maxLayer === b.maxLayer &&
    a.m === b.m &&
    a.efConstruction === b.efConstruction &&
    a.metric === b.metric &&
    a.shuffledBuildCount === b.shuffledBuildCount &&
    a.calibratedMeanLength === b.calibratedMeanLength
  )
}

export function assembleGraphParts(parts: readonly VectorGraphPartPayload[]): VectorGraphParts {
  const name = 'vector graph part'
  const first = parts[0]
  if (first === undefined) invalid(name, 'a field that holds a graph must have at least one part')
  const partLists: NumberedHnswGraph[][] = first.graphs.map(() => [])
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]
    const isLast = p === parts.length - 1
    if (part.fieldName !== first.fieldName || part.graphs.length !== first.graphs.length) {
      invalid(name, `part ${p} lists other graphs than part 0`, { part: p })
    }
    for (let g = 0; g < part.graphs.length; g++) {
      const graph = part.graphs[g]
      if (!sameGraphHeader(graph, first.graphs[g]))
        invalid(name, `part ${p} gives graph ${g} other headers`, { part: p })
      const levels = graph.levels.length
      const fits = isLast ? levels >= 1 && levels <= VECTOR_GRAPH_PART_VECTORS : levels === VECTOR_GRAPH_PART_VECTORS
      if (!fits) invalid(name, `part ${p} gives graph ${g} ${levels} bytes of levels`, { part: p, levels })
      partLists[g].push(graph)
    }
  }
  const graphs: NumberedGraphParts[] = partLists.map(list => ({ partSize: VECTOR_GRAPH_PART_VECTORS, parts: list }))
  return { fieldName: first.fieldName, graphs }
}

export function graphPartsOfEarlierPayload(payload: VectorGraphPayload): VectorGraphParts {
  return {
    fieldName: payload.fieldName,
    graphs: payload.graphs.map(graph => ({ partSize: Math.max(graph.levels.length, 1), parts: [graph] })),
  }
}
