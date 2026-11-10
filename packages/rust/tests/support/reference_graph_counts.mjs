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

const manifest = payloadOf(`${indexName}/manifest`)
const fields = manifest.vectors.map(field => {
  const vectors = []
  for (const file of field.files) {
    const { docIds } = payloadOf(file.key)
    if (docIds.length !== file.count) throw new Error(`${file.key} holds ${docIds.length} IDs for ${file.count}`)
    docIds.forEach((docId, position) => vectors.push({ docId, dead: isDead(file.dead, position) }))
  }
  const levels = new Uint8Array(vectors.length)
  field.graphParts.forEach((part, partNumber) => {
    const payload = payloadOf(part.key)
    if (payload.graphs.length > 1) throw new Error(`${part.key} holds ${payload.graphs.length} graphs`)
    for (const graph of payload.graphs) {
      if (!(graph.levels instanceof Uint8Array)) throw new Error(`${part.key} pages its levels`)
      graph.levels.forEach((level, at) => {
        const number = partNumber * VECTORS_PER_GRAPH_PART + at
        if (level > 0 && number >= vectors.length) throw new Error(`${part.key} holds a node past the vectors`)
        if (level > 0) levels[number] = level
      })
    }
  })
  const liveNodes = []
  const liveWithoutNode = []
  let nodeCount = 0
  let tombstoneCount = 0
  vectors.forEach((vector, number) => {
    const hasNode = levels[number] > 0
    if (hasNode) nodeCount += 1
    if (hasNode && vector.dead) tombstoneCount += 1
    if (hasNode && !vector.dead) liveNodes.push(vector.docId)
    if (!hasNode && !vector.dead) liveWithoutNode.push(vector.docId)
  })
  return {
    fieldPath: field.fieldPath,
    graphParts: field.graphParts.length,
    nodeCount,
    tombstoneCount,
    liveNodes,
    liveWithoutNode,
  }
})
process.stdout.write(JSON.stringify(fields))
