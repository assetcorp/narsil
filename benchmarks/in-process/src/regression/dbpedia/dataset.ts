import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { float32Rows, readNpz, requireArray, unicodeStrings } from './npz'

export const DBPEDIA_DIMENSIONS = 1536
export const DBPEDIA_DOCUMENTS = 100_000
export const DBPEDIA_DIRECTORY_VARIABLE = 'BENCH_DBPEDIA_100K_DIR'

export interface VectorRows {
  ids: string[]
  vectors: Float32Array
  texts: string[]
}

interface ShardManifest {
  dims: number
  rows: number
  shards: number
}

export function dbpediaDirectory(): string {
  const directory = process.env[DBPEDIA_DIRECTORY_VARIABLE]
  if (directory === undefined || directory.length === 0) {
    throw new Error(
      `${DBPEDIA_DIRECTORY_VARIABLE} names no directory; fetch the dataset with python3 -m ir_bench.fetch_dataset dbpedia-entities-openai-100k`,
    )
  }
  return directory
}

function readShardManifest(directory: string, kind: 'docs' | 'queries'): ShardManifest {
  const manifest = JSON.parse(
    readFileSync(resolve(directory, kind, 'manifest.json'), 'utf-8'),
  ) as Partial<ShardManifest>
  const { dims, rows, shards } = manifest
  if (dims !== DBPEDIA_DIMENSIONS || !Number.isSafeInteger(rows) || !Number.isSafeInteger(shards)) {
    throw new Error(`the ${kind} manifest in ${directory} describes no ${DBPEDIA_DIMENSIONS}-dimension shards`)
  }
  return { dims, rows: rows as number, shards: shards as number }
}

function readTexts(path: string): Map<string, { title: string; text: string }> {
  const texts = new Map<string, { title: string; text: string }>()
  for (const line of gunzipSync(readFileSync(path)).toString('utf-8').split('\n')) {
    if (line.trim().length === 0) continue
    const record = JSON.parse(line) as { id?: unknown; title?: unknown; text?: unknown }
    texts.set(String(record.id), {
      title: typeof record.title === 'string' ? record.title : '',
      text: typeof record.text === 'string' ? record.text : '',
    })
  }
  return texts
}

function documentText(title: string, text: string): string {
  const trimmedTitle = title.trim()
  const trimmedText = text.trim()
  if (trimmedTitle.length > 0 && trimmedText.length > 0) return `${trimmedTitle} ${trimmedText}`
  return trimmedTitle.length > 0 ? trimmedTitle : trimmedText
}

function readRows(directory: string, kind: 'docs' | 'queries', limit: number, textFile: string): VectorRows {
  const manifest = readShardManifest(directory, kind)
  const wanted = Math.min(limit, manifest.rows)
  const texts = readTexts(resolve(directory, textFile))
  const vectors = new Float32Array(wanted * DBPEDIA_DIMENSIONS)
  const ids: string[] = []
  const bodies: string[] = []
  for (let shard = 0; shard < manifest.shards && ids.length < wanted; shard++) {
    const name = `shard_${String(shard).padStart(5, '0')}.npz`
    const source = `${kind}/${name}`
    const arrays = readNpz(readFileSync(resolve(directory, kind, name)), source)
    const shardIds = unicodeStrings(requireArray(arrays, 'ids', source), `${source}:ids`)
    const shardVectors = float32Rows(requireArray(arrays, 'vectors', source), `${source}:vectors`)
    if (shardVectors.columns !== DBPEDIA_DIMENSIONS || shardVectors.rows !== shardIds.length) {
      throw new Error(
        `${source} pairs ${shardIds.length} ids with ${shardVectors.rows} rows of ${shardVectors.columns}`,
      )
    }
    const taken = Math.min(shardIds.length, wanted - ids.length)
    vectors.set(shardVectors.values.subarray(0, taken * DBPEDIA_DIMENSIONS), ids.length * DBPEDIA_DIMENSIONS)
    for (let row = 0; row < taken; row++) {
      const id = shardIds[row]
      const record = texts.get(id)
      ids.push(id)
      bodies.push(record === undefined ? '' : documentText(record.title, record.text))
    }
  }
  return { ids, vectors, texts: bodies }
}

export function loadDocuments(directory: string, limit = DBPEDIA_DOCUMENTS): VectorRows {
  return readRows(directory, 'docs', limit, 'documents.jsonl.gz')
}

export function loadQueries(directory: string, limit: number): VectorRows {
  return readRows(directory, 'queries', limit, 'queries.jsonl.gz')
}

export function loadNearestNeighbours(directory: string): Map<string, string[]> {
  const source = 'truth_k10.npz'
  const arrays = readNpz(readFileSync(resolve(directory, source)), source)
  const queryIds = unicodeStrings(requireArray(arrays, 'query_ids', source), `${source}:query_ids`)
  const neighbours = requireArray(arrays, 'neighbors', source)
  const flat = unicodeStrings(neighbours, `${source}:neighbors`)
  const width = neighbours.shape[1]
  if (neighbours.shape.length !== 2 || neighbours.shape[0] !== queryIds.length || width === undefined) {
    throw new Error(
      `${source} pairs ${queryIds.length} queries with neighbours of shape ${JSON.stringify(neighbours.shape)}`,
    )
  }
  const truth = new Map<string, string[]>()
  queryIds.forEach((queryId, row) => {
    truth.set(queryId, flat.slice(row * width, (row + 1) * width))
  })
  return truth
}

export function vectorOf(rows: VectorRows, row: number): Float32Array {
  return rows.vectors.slice(row * DBPEDIA_DIMENSIONS, (row + 1) * DBPEDIA_DIMENSIONS)
}
