import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const [repositoryRoot, directory, indexName] = process.argv.slice(2)
const require = createRequire(join(repositoryRoot, 'packages/ts/package.json'))
const { decode } = require('@msgpack/msgpack')

const HEADER_BYTES = 32
const LENGTH_OFFSET = 8
const FLAGS_OFFSET = 12
const FLAG_COMPRESSED = 1
const ALGORITHM_SHIFT = 1
const ALGORITHM_MASK = 3
const GZIP_ALGORITHM = 1
const VECTORS_PER_GRAPH_PART = 16_384

function payloadOf(key) {
  const bytes = readFileSync(join(directory, key))
  const flags = bytes.readUInt16BE(FLAGS_OFFSET)
  const length = bytes.readUInt32BE(LENGTH_OFFSET)
  const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + length)
  if ((flags & FLAG_COMPRESSED) === 0) return decode(payload)
  if (((flags >> ALGORITHM_SHIFT) & ALGORITHM_MASK) !== GZIP_ALGORITHM) throw new Error(`${key} uses another algorithm`)
  return decode(gunzipSync(payload))
}

function isDead(dead, position) {
  if (dead === null || dead === undefined) return false
  return (dead[Math.floor(position / 8)] & (1 << (position % 8))) !== 0
}

function startOf(entryPoint, levels) {
  if (entryPoint !== null && levels[entryPoint] > 0) return entryPoint
  let highest = null
  levels.forEach((level, number) => {
    if (level > 0 && (highest === null || level > levels[highest])) highest = number
  })
  return highest
}

function reachedFrom(start, baseLists) {
  const reached = new Set()
  if (start === null) return reached
  reached.add(start)
  const waiting = [start]
  for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
    for (const neighbour of baseLists.get(next) ?? []) {
      if (reached.has(neighbour) || !baseLists.has(neighbour)) continue
      reached.add(neighbour)
      waiting.push(neighbour)
    }
  }
  return reached
}

const manifest = payloadOf(`${indexName}/manifest`)
const fields = manifest.vectors.map(field => {
  const vectors = []
  for (const file of field.files) {
    const { docIds } = payloadOf(file.key)
    if (docIds.length !== file.count) throw new Error(`${file.key} holds ${docIds.length} IDs for ${file.count}`)
    docIds.forEach((docId, position) => vectors.push({ docId, dead: isDead(file.dead, position) }))
  }
  const levels = new Uint8Array(vectors.length)
  const baseLists = new Map()
  let entryPoint = null
  field.graphParts.forEach((part, partNumber) => {
    const payload = payloadOf(part.key)
    if (payload.graphs.length > 1) throw new Error(`${part.key} holds ${payload.graphs.length} graphs`)
    for (const graph of payload.graphs) {
      if (!(graph.levels instanceof Uint8Array)) throw new Error(`${part.key} pages its levels`)
      if (partNumber === 0) entryPoint = graph.entryPoint ?? null
      const words = new DataView(graph.neighbours.buffer, graph.neighbours.byteOffset, graph.neighbours.byteLength)
      let word = 0
      graph.levels.forEach((level, at) => {
        const number = partNumber * VECTORS_PER_GRAPH_PART + at
        if (level > 0 && number >= vectors.length) throw new Error(`${part.key} holds a node past the vectors`)
        if (level > 0) levels[number] = level
        for (let layer = 0; layer < level; layer++) {
          const count = words.getUint32(word * 4, true)
          if (layer === 0) {
            const list = []
            for (let i = 1; i <= count; i++) list.push(words.getUint32((word + i) * 4, true))
            baseLists.set(number, list)
          }
          word += count + 1
        }
      })
    }
  })
  const reached = reachedFrom(startOf(entryPoint, levels), baseLists)
  const liveNodes = []
  const liveWithoutNode = []
  const unreachedLiveNodes = []
  let nodeCount = 0
  let tombstoneCount = 0
  vectors.forEach((vector, number) => {
    const hasNode = levels[number] > 0
    if (hasNode) nodeCount += 1
    if (hasNode && vector.dead) tombstoneCount += 1
    if (hasNode && !vector.dead) liveNodes.push(vector.docId)
    if (hasNode && !vector.dead && !reached.has(number)) unreachedLiveNodes.push(vector.docId)
    if (!hasNode && !vector.dead) liveWithoutNode.push(vector.docId)
  })
  return {
    fieldPath: field.fieldPath,
    graphParts: field.graphParts.length,
    nodeCount,
    tombstoneCount,
    liveNodes,
    liveWithoutNode,
    unreachedLiveNodes,
  }
})
process.stdout.write(JSON.stringify(fields))
