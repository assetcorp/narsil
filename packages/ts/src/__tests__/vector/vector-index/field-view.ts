import type { SerializedHNSWGraph } from '../../../vector/hnsw'
import type { VectorIndex, VectorIndexCodes } from '../../../vector/vector-index'

export interface FieldView {
  docIds: string[]
  vectors: Uint8Array
  codes: VectorIndexCodes | null
  graphs: SerializedHNSWGraph[]
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function graphOf(
  graphs: ReadonlyArray<{
    entryPoint: number | null
    maxLayer: number
    m: number
    efConstruction: number
    metric: SerializedHNSWGraph['metric']
    levels: Uint8Array
    neighbours: Uint8Array
  }>,
  partSize: number,
  docIds: readonly string[],
): SerializedHNSWGraph | null {
  const first = graphs[0]
  if (first === undefined) return null
  const nodes: SerializedHNSWGraph['nodes'] = []
  graphs.forEach((part, partIndex) => {
    const view = new DataView(part.neighbours.buffer, part.neighbours.byteOffset, part.neighbours.byteLength)
    let cursor = 0
    for (let at = 0; at < part.levels.length; at++) {
      const layers = part.levels[at]
      const layerConns: Array<[number, string[]]> = []
      for (let layer = 0; layer < layers; layer++) {
        const count = view.getUint32(cursor * 4, true)
        const neighbours: string[] = []
        for (let i = 1; i <= count; i++) {
          const neighbour = docIds[view.getUint32((cursor + i) * 4, true)]
          if (neighbour !== undefined) neighbours.push(neighbour)
        }
        cursor += count + 1
        if (neighbours.length > 0) layerConns.push([layer, neighbours])
      }
      const docId = docIds[partIndex * partSize + at]
      if (layers > 0 && docId !== undefined) nodes.push([docId, layers - 1, layerConns])
    }
  })
  return {
    entryPoint: first.entryPoint === null ? null : (docIds[first.entryPoint] ?? null),
    maxLayer: first.maxLayer,
    m: first.m,
    efConstruction: first.efConstruction,
    metric: first.metric,
    nodes,
  }
}

export function fieldView(index: VectorIndex): FieldView {
  const plan = index.planCheckpoint(null)
  const docIds: string[] = []
  const vectors: Uint8Array[] = []
  const records: Uint8Array[] = []
  let codes: VectorIndexCodes | null = null
  for (let file = 0; file < plan.newFiles; file++) {
    const { payload } = plan.readNewFile(file)
    docIds.push(...payload.docIds)
    vectors.push(payload.vectors)
    if (payload.codes !== null) {
      codes ??= { bits: payload.codes.bits, centroid: payload.codes.centroid, records: new Uint8Array(0) }
      records.push(payload.codes.records)
    }
  }
  if (codes !== null) codes = { ...codes, records: joined(records) }
  const parts = plan.graphParts ?? []
  const firstPart = parts[0]?.graphs[0]
  const graph = graphOf(
    parts.flatMap(part => part.graphs),
    firstPart === undefined ? 1 : firstPart.levels.length,
    docIds,
  )
  return { docIds, vectors: joined(vectors), codes, graphs: graph === null ? [] : [graph] }
}
