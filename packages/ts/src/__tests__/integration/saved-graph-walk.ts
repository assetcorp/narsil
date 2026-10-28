import { gunzipSync } from 'node:zlib'
import { decode } from '@msgpack/msgpack'

const TAR_BLOCK_BYTES = 512
const TAR_NAME_BYTES = 100
const TAR_SIZE_OFFSET = 124
const TAR_SIZE_BYTES = 12
const TAR_TYPE_OFFSET = 156
const TAR_PREFIX_OFFSET = 345
const TAR_PREFIX_BYTES = 155
const PAX_HEADER_TYPE = 'x'
const REGULAR_FILE_TYPES = new Set(['0', '\0'])
const ENVELOPE_HEADER_BYTES = 32
const ENVELOPE_MAGIC = 'NRSL'
const ENVELOPE_LENGTH_OFFSET = 8
const ENVELOPE_FLAGS_OFFSET = 12
const COMPRESSED_FLAG = 0b1
const GZIP_FLAGS = 0b010
const COMPRESSION_ALGORITHM_FLAGS = 0b110
const VECTORS_PER_GRAPH_PART = 16_384

interface SavedVectorFile {
  key: string
  count: number
  dead: Uint8Array | null
}

interface SavedVectorField {
  fieldPath: string
  files: SavedVectorFile[]
  graphParts: Array<{ key: string }>
}

interface SavedGraph {
  entryPoint: number | null
  levels: Uint8Array
  neighbours: Uint8Array
  shuffledBuildCount?: number
  calibratedMeanLength?: number
}

export interface SavedBuildHistory {
  shuffledBuildCount: number | null
  calibratedMeanLength: number | null
}

export interface GraphWalk {
  liveDocIds: string[]
  graphCount: number
  nodeCount: number
  unplaced: string[]
  unreached: string[]
  baseListOf: Map<string, string[]>
}

export async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.length
  }
  return joined
}

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function paxPath(record: Uint8Array): string | null {
  for (const line of new TextDecoder().decode(record).split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(line)
    if (match !== null) return match[1]
  }
  return null
}

export function archiveEntries(archive: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>()
  let at = 0
  let longName: string | null = null
  while (at + TAR_BLOCK_BYTES <= archive.length) {
    const header = archive.subarray(at, at + TAR_BLOCK_BYTES)
    if (header.every(byte => byte === 0)) break
    const size = Number.parseInt(text(header.subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_BYTES)).trim(), 8)
    const type = String.fromCharCode(header[TAR_TYPE_OFFSET])
    const body = archive.subarray(at + TAR_BLOCK_BYTES, at + TAR_BLOCK_BYTES + size)
    at += TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
    if (type === PAX_HEADER_TYPE) {
      longName = paxPath(body)
      continue
    }
    if (!REGULAR_FILE_TYPES.has(type)) throw new Error(`the archive holds an entry of type ${type}`)
    const prefix = text(header.subarray(TAR_PREFIX_OFFSET, TAR_PREFIX_OFFSET + TAR_PREFIX_BYTES))
    const name = text(header.subarray(0, TAR_NAME_BYTES))
    entries.set(longName ?? (prefix.length > 0 ? `${prefix}/${name}` : name), body)
    longName = null
  }
  return entries
}

export function envelopePayload(file: Uint8Array): unknown {
  if (new TextDecoder().decode(file.subarray(0, 4)) !== ENVELOPE_MAGIC) throw new Error('the file holds no NRSL magic')
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const length = view.getUint32(ENVELOPE_LENGTH_OFFSET, false)
  const flags = view.getUint16(ENVELOPE_FLAGS_OFFSET, false)
  const payload = file.subarray(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + length)
  if ((flags & COMPRESSED_FLAG) === 0) return decode(payload)
  if ((flags & COMPRESSION_ALGORITHM_FLAGS) !== GZIP_FLAGS) throw new Error(`the file uses compression flags ${flags}`)
  return decode(gunzipSync(payload))
}

function entryOf(entries: Map<string, Uint8Array>, indexName: string, key: string): Uint8Array {
  const name = key.startsWith(`${indexName}/`) ? key.slice(indexName.length + 1) : key
  const entry = entries.get(name)
  if (entry === undefined) throw new Error(`the archive lacks ${name}`)
  return entry
}

function isDeadAt(dead: Uint8Array | null, position: number): boolean {
  return dead !== null && ((dead[Math.floor(position / 8)] >> (position % 8)) & 1) === 1
}

function baseLists(graph: SavedGraph, part: number, lists: Map<number, number[]>, levels: Map<number, number>): void {
  const view = new DataView(graph.neighbours.buffer, graph.neighbours.byteOffset, graph.neighbours.byteLength)
  let word = 0
  for (let at = 0; at < graph.levels.length; at++) {
    const layers = graph.levels[at]
    if (layers === 0) continue
    const number = part * VECTORS_PER_GRAPH_PART + at
    levels.set(number, layers)
    for (let layer = 0; layer < layers; layer++) {
      const count = view.getUint32(word * 4, true)
      if (layer === 0) {
        const list: number[] = []
        for (let i = 1; i <= count; i++) list.push(view.getUint32((word + i) * 4, true))
        lists.set(number, list)
      }
      word += count + 1
    }
  }
}

function startOf(entryPoint: number | null, levels: Map<number, number>): number | null {
  if (entryPoint !== null && levels.has(entryPoint)) return entryPoint
  let highest: number | null = null
  for (const [number, layers] of levels) {
    if (highest === null || layers > (levels.get(highest) ?? 0)) highest = number
  }
  return highest
}

function reachedFrom(start: number | null, lists: Map<number, number[]>): Set<number> {
  const reached = new Set<number>()
  if (start === null) return reached
  reached.add(start)
  const waiting = [start]
  for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
    for (const neighbour of lists.get(next) ?? []) {
      if (reached.has(neighbour) || !lists.has(neighbour)) continue
      reached.add(neighbour)
      waiting.push(neighbour)
    }
  }
  return reached
}

export async function walkSavedGraph(
  snapshot: ReadableStream<Uint8Array>,
  indexName: string,
  fieldPath: string,
): Promise<GraphWalk> {
  const entries = archiveEntries(await bytesOf(snapshot))
  const manifestEntry = entries.get('manifest')
  if (manifestEntry === undefined) throw new Error('the archive holds no manifest')
  const manifest = envelopePayload(manifestEntry) as { vectors: SavedVectorField[] }
  const field = manifest.vectors.find(vectors => vectors.fieldPath === fieldPath)
  if (field === undefined) throw new Error(`the manifest lists no vector field ${fieldPath}`)

  const docIds: string[] = []
  const live: boolean[] = []
  for (const file of field.files) {
    const payload = envelopePayload(entryOf(entries, indexName, file.key)) as { docIds: string[] }
    payload.docIds.forEach((docId, position) => {
      docIds.push(docId)
      live.push(!isDeadAt(file.dead, position))
    })
  }

  const graphs: Array<{ lists: Map<number, number[]>; levels: Map<number, number>; entryPoint: number | null }> = []
  field.graphParts.forEach((partRef, part) => {
    const payload = envelopePayload(entryOf(entries, indexName, partRef.key)) as { graphs: SavedGraph[] }
    payload.graphs.forEach((graph, position) => {
      graphs[position] ??= { lists: new Map(), levels: new Map(), entryPoint: graph.entryPoint }
      baseLists(graph, part, graphs[position].lists, graphs[position].levels)
    })
  })
  const reached = graphs.map(graph => reachedFrom(startOf(graph.entryPoint, graph.levels), graph.lists))

  const walk: GraphWalk = {
    liveDocIds: [],
    graphCount: graphs.length,
    nodeCount: graphs.reduce((total, graph) => total + graph.lists.size, 0),
    unplaced: [],
    unreached: [],
    baseListOf: new Map(),
  }
  for (const [number, list] of graphs[0]?.lists ?? []) {
    walk.baseListOf.set(
      docIds[number],
      list.map(neighbour => docIds[neighbour]),
    )
  }
  docIds.forEach((docId, number) => {
    if (!live[number]) return
    walk.liveDocIds.push(docId)
    const holder = graphs.findIndex(graph => graph.lists.has(number))
    if (holder === -1) walk.unplaced.push(docId)
    else if (!reached[holder].has(number)) walk.unreached.push(docId)
  })
  return walk
}

export async function savedBuildHistories(
  snapshot: ReadableStream<Uint8Array>,
  indexName: string,
  fieldPath: string,
): Promise<SavedBuildHistory[]> {
  const entries = archiveEntries(await bytesOf(snapshot))
  const manifestEntry = entries.get('manifest')
  if (manifestEntry === undefined) throw new Error('the archive holds no manifest')
  const manifest = envelopePayload(manifestEntry) as { vectors: SavedVectorField[] }
  const field = manifest.vectors.find(vectors => vectors.fieldPath === fieldPath)
  if (field === undefined) throw new Error(`the manifest lists no vector field ${fieldPath}`)
  return field.graphParts.flatMap(partRef => {
    const payload = envelopePayload(entryOf(entries, indexName, partRef.key)) as { graphs: SavedGraph[] }
    return payload.graphs.map(graph => ({
      shuffledBuildCount: graph.shuffledBuildCount ?? null,
      calibratedMeanLength: graph.calibratedMeanLength ?? null,
    }))
  })
}
