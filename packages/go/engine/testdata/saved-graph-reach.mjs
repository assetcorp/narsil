import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const [directory, indexName] = process.argv.slice(2)
const requireFromTypeScript = createRequire(new URL('../../../ts/package.json', import.meta.url))
const { decode } = requireFromTypeScript('@msgpack/msgpack')

const headerBytes = 32
const payloadLengthOffset = 8
const flagsOffset = 12
const compressedBit = 1
const algorithmShift = 1
const algorithmMask = 3
const gzip = 1
const vectorsPerGraphPart = 16_384
const wordBytes = 4
const unreachedExamples = 5

function payloadAt(key) {
  const file = readFileSync(join(directory, key))
  if (file.toString('latin1', 0, 4) !== 'NRSL') throw new Error(`${key} does not open with the magic bytes`)
  const flags = file.readUInt16BE(flagsOffset)
  const stored = file.subarray(headerBytes, headerBytes + file.readUInt32BE(payloadLengthOffset))
  if ((flags & compressedBit) === 0) return decode(stored)
  if (((flags >> algorithmShift) & algorithmMask) !== gzip)
    throw new Error(`${key} is compressed with another algorithm`)
  return decode(gunzipSync(stored))
}

function numberedVectors(files) {
  const vectors = []
  for (const file of files) {
    const { docIds } = payloadAt(file.key)
    if (docIds.length !== file.count)
      throw new Error(`${file.key} holds ${docIds.length} IDs, while the manifest counts ${file.count}`)
    for (let position = 0; position < docIds.length; position++) {
      const dead = file.dead != null && (file.dead[position >> 3] & (1 << (position & 7))) !== 0
      vectors.push({ docId: docIds[position], dead })
    }
  }
  return vectors
}

function savedGraph(graphParts, vectorCount) {
  const layers = new Uint8Array(vectorCount)
  const baseLists = new Array(vectorCount)
  let entryPoint = null
  graphParts.forEach((part, partNumber) => {
    const { graphs } = payloadAt(part.key)
    if (graphs.length !== 1) throw new Error(`${part.key} holds ${graphs.length} graphs, where this reader follows one`)
    const [graph] = graphs
    if (!(graph.levels instanceof Uint8Array)) throw new Error(`${part.key} stores its levels outside the payload`)
    if (partNumber === 0) entryPoint = graph.entryPoint ?? null
    const words = new DataView(graph.neighbours.buffer, graph.neighbours.byteOffset, graph.neighbours.byteLength)
    let word = 0
    for (let at = 0; at < graph.levels.length; at++) {
      const layerCount = graph.levels[at]
      if (layerCount === 0) continue
      const number = partNumber * vectorsPerGraphPart + at
      if (number >= vectorCount)
        throw new Error(`${part.key} holds node ${number}, while the field numbers ${vectorCount} vectors`)
      layers[number] = layerCount
      for (let layer = 0; layer < layerCount; layer++) {
        const count = words.getUint32(word * wordBytes, true)
        if (layer === 0) {
          const list = new Uint32Array(count)
          for (let i = 0; i < count; i++) list[i] = words.getUint32((word + 1 + i) * wordBytes, true)
          baseLists[number] = list
        }
        word += count + 1
      }
    }
  })
  return { layers, baseLists, entryPoint }
}

function searchStart({ layers, entryPoint }) {
  if (entryPoint !== null && layers[entryPoint] > 0) return entryPoint
  let highest = null
  for (let number = 0; number < layers.length; number++) {
    if (layers[number] > 0 && (highest === null || layers[number] > layers[highest])) highest = number
  }
  return highest
}

function reachedAlongLayerZero(graph) {
  const reached = new Uint8Array(graph.layers.length)
  const start = searchStart(graph)
  if (start === null) return reached
  reached[start] = 1
  const waiting = [start]
  while (waiting.length > 0) {
    const node = waiting.pop()
    for (const neighbour of graph.baseLists[node]) {
      if (neighbour >= reached.length || graph.layers[neighbour] === 0 || reached[neighbour] === 1) continue
      reached[neighbour] = 1
      waiting.push(neighbour)
    }
  }
  return reached
}

const manifest = payloadAt(`${indexName}/manifest`)
const report = manifest.vectors.map(field => {
  const vectors = numberedVectors(field.files)
  const graph = savedGraph(field.graphParts, vectors.length)
  const reached = reachedAlongLayerZero(graph)
  const counts = {
    fieldPath: field.fieldPath,
    graphParts: field.graphParts.length,
    nodes: 0,
    liveNodes: 0,
    liveWithoutNode: 0,
    unreachedLiveNodes: 0,
    unreachedExamples: [],
  }
  vectors.forEach((vector, number) => {
    const placed = graph.layers[number] > 0
    if (placed) counts.nodes += 1
    if (vector.dead) return
    if (!placed) {
      counts.liveWithoutNode += 1
      return
    }
    counts.liveNodes += 1
    if (reached[number] === 1) return
    counts.unreachedLiveNodes += 1
    if (counts.unreachedExamples.length < unreachedExamples) counts.unreachedExamples.push(vector.docId)
  })
  return counts
})
process.stdout.write(JSON.stringify(report))
