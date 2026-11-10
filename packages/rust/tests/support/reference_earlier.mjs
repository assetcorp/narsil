import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

const [repositoryRoot] = process.argv.slice(2)
const require = createRequire(join(repositoryRoot, 'packages/ts/package.json'))
const { decode, encode } = require('@msgpack/msgpack')

const SAMPLES = join(repositoryRoot, 'packages/conformance/samples/earlier-releases/0.3.0')
const HEADER_BYTES = 32
const MAX_LAYER_CAP = 32
const FLOAT32_BYTES = 4
const VECTOR_TYPE = /^vector\[\d+\]$/
const ENGINE_VERSION = [0, 3, 0]
const TWO_PARTS_SPLIT = 200
const LATER_GRAPH_NODES = [5, 250]
const STORED_VECTOR_COMPONENT = 0.5

function payloadOf(bytes) {
  const length = bytes.readUInt32BE(8)
  const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + length)
  return bytes.readUInt16BE(12) & 1 ? gunzipSync(payload) : payload
}

function envelope(version, payload) {
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('NRSL', 0, 'ascii')
  header[4] = version
  ENGINE_VERSION.forEach((part, at) => {
    header[5 + at] = part
  })
  header.writeUInt32BE(payload.length, 8)
  return Buffer.concat([header, Buffer.from(payload)])
}

function removeAtPath(fields, path) {
  const segments = path.split('.')
  let current = fields
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (next === null || typeof next !== 'object') return
    current = next
  }
  delete current[segments[segments.length - 1]]
}

function documentsForm(bytes) {
  const raw = decode(bytes)
  const schema = raw.schema ?? {}
  const vectorPaths = Object.entries(schema)
    .filter(([, type]) => VECTOR_TYPE.test(type))
    .map(([path]) => path)
  const documents = Object.entries(raw.documents ?? {}).map(([id, document]) => {
    const fields = document.fields
    for (const path of vectorPaths) removeAtPath(fields, path)
    return [id, fields]
  })
  return { schema, documents }
}

function partForm(part) {
  const view = new DataView(part.vectors.buffer, part.vectors.byteOffset, part.vectors.byteLength)
  const vectors = part.docIds.map((_, row) =>
    Array.from({ length: part.dimension }, (_, at) =>
      view.getFloat32((row * part.dimension + at) * FLOAT32_BYTES, true),
    ),
  )
  const codes =
    part.codes === null || part.codes === undefined
      ? null
      : { bits: part.codes.bits, centroid: part.codes.centroid, recordBytes: part.codes.records.length }
  return {
    fieldName: part.fieldName,
    dimension: part.dimension,
    part: part.part,
    parts: part.parts,
    docIds: part.docIds,
    vectors,
    codes,
  }
}

function clampLayer(value) {
  return Math.min(Math.max(value, 0), MAX_LAYER_CAP)
}

function resolvedNodes(nodes, numbers) {
  const byNumber = new Map()
  for (const [id, top, layers] of nodes) {
    const number = numbers.get(id)
    if (number === undefined) continue
    byNumber.set(number, { number, top: Math.floor(clampLayer(top)), layers })
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number)
}

function neighbourLists(node, m, numbers) {
  const chosen = new Map()
  for (const [layer, neighbours] of node.layers) {
    if (Number.isInteger(layer) && layer >= 0 && layer <= node.top) chosen.set(layer, neighbours)
  }
  const out = []
  for (let layer = 0; layer <= node.top; layer++) {
    const limit = layer === 0 ? 2 * m : m
    const kept = []
    for (const id of chosen.get(layer) ?? []) {
      if (kept.length >= limit) break
      const number = numbers.get(id)
      if (number !== undefined && !kept.includes(number)) kept.push(number)
    }
    out.push(kept.length, ...kept)
  }
  return out
}

function graphsForm(parts) {
  const numbers = new Map(parts.flatMap(part => part.docIds).map((id, number) => [id, number]))
  const graphs = []
  let sequence = []
  parts.forEach((part, index) => {
    if (index === 0 || part.part === 0) {
      sequence = []
      graphs.push(sequence)
    }
    part.graphs.forEach((graph, at) => {
      if (sequence[at] === undefined) sequence[at] = { ...graph, nodes: [...graph.nodes] }
      else sequence[at].nodes.push(...graph.nodes)
    })
  })
  const filled = graphs.flat().filter(graph => graph.nodes.length > 0)
  if (filled.length === 0) return null
  const [first, ...later] = filled
  if (typeof first.metric !== 'string' || typeof first.efConstruction !== 'number') return null
  const header = { m: first.m, efConstruction: first.efConstruction, metric: first.metric }
  const nodes = resolvedNodes(first.nodes, numbers)
  const levels = new Array(nodes.length === 0 ? 0 : nodes[nodes.length - 1].number + 1).fill(0)
  const neighbours = []
  for (const node of nodes) {
    levels[node.number] = node.top + 1
    neighbours.push(...neighbourLists(node, first.m, numbers))
  }
  const entryNumber = typeof first.entryPoint === 'string' ? numbers.get(first.entryPoint) : undefined
  const entryPoint = entryNumber !== undefined && levels[entryNumber] > 0 ? entryNumber : null
  const out = [{ entryPoint, maxLayer: clampLayer(first.maxLayer), ...header, levels, neighbours }]
  const laterNumbers = new Set(later.flatMap(graph => resolvedNodes(graph.nodes, numbers).map(node => node.number)))
  if (laterNumbers.size > 0) {
    const laterLevels = new Array(Math.max(...laterNumbers) + 1).fill(0)
    for (const number of laterNumbers) laterLevels[number] = 1
    out.push({
      entryPoint: null,
      maxLayer: 0,
      ...header,
      levels: laterLevels,
      neighbours: new Array(laterNumbers.size).fill(0),
    })
  }
  return out
}

function bundleForm(raw) {
  const vectorIndexes = {}
  for (const [path, parts] of Object.entries(raw.vectorIndexes ?? {})) {
    vectorIndexes[path] = { parts: parts.map(partForm), graphs: graphsForm(parts) }
  }
  return {
    schema: raw.schema,
    language: raw.language,
    partitions: raw.partitions.map(documentsForm),
    vectorIndexes,
    checkpoint: (raw.checkpoint ?? []).map(({ partitionId, lastSeqNo, primaryTerm }) => ({
      partitionId,
      lastSeqNo,
      primaryTerm,
    })),
  }
}

function indexSnapshotForm(raw) {
  const { schema, language, partitions, vectorIndexes, ...settings } = raw
  const fields = {}
  for (const [path, parts] of Object.entries(vectorIndexes ?? {})) fields[path] = parts.map(partForm)
  return { settings, schema, language, partitions: partitions.map(documentsForm), vectorIndexes: fields }
}

function filesUnder(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function segmentForms() {
  const forms = {}
  for (const path of filesUnder(join(SAMPLES, 'wal'))) {
    const sampleName = relative(SAMPLES, path).split(sep).join('/')
    if (!/\/segments\/\d+\/s\d+$/.test(sampleName)) continue
    const container = decode(payloadOf(readFileSync(path)))
    forms[sampleName] = {
      partition: documentsForm(container.payload),
      tombstones: container.tombstones ?? [],
    }
  }
  return forms
}

function craftedBundle(change) {
  const bundle = decode(payloadOf(readFileSync(join(SAMPLES, 'snapshot-tier/products/snapshot'))))
  const snapshot = decode(payloadOf(readFileSync(join(SAMPLES, 'products-0.3.0.nrsl'))))
  const [whole] = snapshot.vectorIndexes.embedding
  const partition = decode(bundle.partitions[0])
  for (const document of Object.values(partition.documents)) {
    document.fields.embedding = new Array(whole.dimension).fill(STORED_VECTOR_COMPONENT)
  }
  bundle.partitions[0] = encode(partition)
  const width = whole.dimension * FLOAT32_BYTES
  const graph = whole.graphs[0]
  const firstIds = new Set(whole.docIds.slice(0, TWO_PARTS_SPLIT))
  const graphOf = nodes => ({ ...graph, nodes })
  const laterGraph = {
    ...graph,
    entryPoint: null,
    maxLayer: 0,
    nodes: LATER_GRAPH_NODES.map(at => [whole.docIds[at], 0, []]),
  }
  const parts = [
    {
      ...whole,
      parts: 2,
      docIds: whole.docIds.slice(0, TWO_PARTS_SPLIT),
      vectors: whole.vectors.slice(0, TWO_PARTS_SPLIT * width),
      codes: null,
      graphs: [graphOf(graph.nodes.filter(([id]) => firstIds.has(id))), laterGraph],
    },
    {
      ...whole,
      part: 1,
      parts: 2,
      docIds: whole.docIds.slice(TWO_PARTS_SPLIT),
      vectors: whole.vectors.slice(TWO_PARTS_SPLIT * width),
      codes: null,
      graphs: [graphOf(graph.nodes.filter(([id]) => !firstIds.has(id)))],
    },
  ]
  bundle.vectorIndexes = { embedding: parts }
  change(bundle, parts)
  return bundle
}

const crafted = {
  'graph-in-two-parts': craftedBundle(() => {}),
  'graph-m-below-two': craftedBundle((_, parts) => {
    for (const part of parts) part.graphs[0].m = 1
  }),
  'graph-upper-lists-beyond-bound': craftedBundle((_, parts) => {
    for (const part of parts)
      part.graphs[0].nodes = part.graphs[0].nodes.map(([id, , layers]) => [id, MAX_LAYER_CAP, layers])
  }),
  'vectors-short-by-one-component': craftedBundle((_, parts) => {
    parts[0].vectors = parts[0].vectors.slice(FLOAT32_BYTES)
  }),
  'bundle-layout-three': craftedBundle(bundle => {
    bundle.version = 3
  }),
}

const craftedForms = {}
for (const [name, bundle] of Object.entries(crafted)) {
  craftedForms[name] = {
    file: { $bytes: envelope(2, encode(bundle)).toString('base64') },
    form: name === 'graph-in-two-parts' ? bundleForm(bundle) : null,
  }
}

const bundles = {}
for (const path of ['snapshot-tier/products/snapshot', 'snapshot-tier-numeric-ids/pantry/snapshot']) {
  bundles[path] = bundleForm(decode(payloadOf(readFileSync(join(SAMPLES, path)))))
}

process.stdout.write(
  JSON.stringify({
    segments: segmentForms(),
    bundles,
    snapshots: {
      'products-0.3.0.nrsl': indexSnapshotForm(decode(payloadOf(readFileSync(join(SAMPLES, 'products-0.3.0.nrsl'))))),
    },
    crafted: craftedForms,
  }),
)
