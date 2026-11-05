import { type CaseBuild, damagedCheckpoint } from './build'
import {
  baseFile,
  bytesAt,
  listAt,
  mapAt,
  otherChecksum,
  packedUint32s,
  type RawMap,
  rewritten,
  uint32s,
} from './bytes'
import { firstGraphLayout, headSection, sectionBytesOf, withChangedHead, withFreshPageChecksums } from './heads'

const LOAD_FAILED = 'PERSISTENCE_LOAD_FAILED'
const CRC_MISMATCH = 'PERSISTENCE_CRC_MISMATCH'
const VERSION_MISMATCH = 'ENVELOPE_VERSION_MISMATCH'
const VECTOR_RULE = 'envelope.md#vector-file-payload'
const GRAPH_RULE = 'envelope.md#vector-graph-payload'
const MANIFEST_RULE = 'durability.md#manifest'
const DISK = 'notes'
const MEMORY = 'products'
const DISK_FILE = 'segments/vec-embedding-1l4nfg2-f0000000000000000'
const DISK_GRAPH = 'segments/vec-embedding-1l4nfg2-graph-g1-p0000000000000000'
const MEMORY_FILE = 'segments/vec-embedding-1l4nfg2-f0000000000000000'
const MEMORY_GRAPH = 'segments/vec-embedding-1l4nfg2-graph-g2-p0000000000000000'
const OVERLAP_BYTES = 30
const GRAPH_PART_VECTORS = 16_384
const COUNT_PAST_NEXT_OFFSET = 1_000

function firstGraph(payload: RawMap): RawMap {
  return mapAt(listAt(payload.graphs, 'graphs')[0], 'graphs[0]')
}

function vectorRefs(manifest: RawMap): RawMap {
  return mapAt(listAt(manifest.vectors, 'vectors')[0], 'vectors[0]')
}

function fileRef(manifest: RawMap, at: number): RawMap {
  return mapAt(listAt(vectorRefs(manifest).files, 'files')[at], `files[${at}]`)
}

function graphRef(manifest: RawMap): RawMap {
  return mapAt(listAt(vectorRefs(manifest).graphParts, 'graphParts')[0], 'graphParts[0]')
}

async function manifestCase(name: string, rule: string, code: string, index: string, change: (m: RawMap) => void) {
  const manifest = await rewritten(await baseFile(index, 'manifest'), name, change)
  return damagedCheckpoint(name, rule, code, index, { manifest })
}

async function memoryGraphCase(name: string, code: string, change: (payload: RawMap) => void) {
  const graph = await rewritten(await baseFile(MEMORY, MEMORY_GRAPH), name, change)
  return damagedCheckpoint(name, GRAPH_RULE, code, MEMORY, { [MEMORY_GRAPH]: graph })
}

function neighboursListAfterFirstNode(edit: Parameters<Parameters<typeof withChangedHead>[2]>[0]): void {
  const layout = firstGraphLayout(edit.head)
  const offsets = uint32s(bytesAt(layout.nodeOffsets, 'nodeOffsets'))
  const node = offsets.findIndex((start, at) => (offsets[at + 1] ?? start) > start)
  if (node < 0) throw new Error('the graph part holds no node')
  const neighbours = mapAt(layout.neighbours, 'neighbours')
  const bytes = sectionBytesOf(edit, neighbours)
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offsets[node] ?? 0,
    COUNT_PAST_NEXT_OFFSET,
    true,
  )
  withFreshPageChecksums(edit, neighbours)
}

function changedNodeOffsets(
  edit: Parameters<Parameters<typeof withChangedHead>[2]>[0],
  change: (values: number[]) => void,
) {
  const layout = firstGraphLayout(edit.head)
  const values = uint32s(bytesAt(layout.nodeOffsets, 'nodeOffsets'))
  change(values)
  layout.nodeOffsets = packedUint32s(values)
}

async function twoPartCase(name: string, changeSecond: (graph: RawMap) => void): Promise<CaseBuild> {
  const graphFile = await baseFile(MEMORY, MEMORY_GRAPH)
  const secondKey = MEMORY_GRAPH.replace(/p0{16}$/, 'p0000000000000001')
  const first = await rewritten(graphFile, name, payload => {
    const graph = firstGraph(payload)
    const levels = new Uint8Array(GRAPH_PART_VECTORS)
    levels.set(bytesAt(graph.levels, 'levels'))
    graph.levels = levels
  })
  const second = await rewritten(graphFile, name, payload => {
    const graph = firstGraph(payload)
    graph.levels = new Uint8Array(1)
    graph.neighbours = new Uint8Array(0)
    changeSecond(graph)
  })
  const manifest = await rewritten(await baseFile(MEMORY, 'manifest'), name, payload => {
    listAt(vectorRefs(payload).graphParts, 'graphParts').push({ ...graphRef(payload), key: `${MEMORY}/${secondKey}` })
  })
  return damagedCheckpoint(name, GRAPH_RULE, LOAD_FAILED, MEMORY, {
    manifest,
    [MEMORY_GRAPH]: first,
    [secondKey]: second,
  })
}

export async function vectorCases(): Promise<CaseBuild[]> {
  return [
    await twoPartCase('graph-parts-disagree', graph => {
      graph.m = Number(graph.m) + 1
    }),
    await manifestCase('vector-head-checksum', MANIFEST_RULE, CRC_MISMATCH, DISK, manifest => {
      const ref = fileRef(manifest, 0)
      ref.headChecksum = otherChecksum(ref.headChecksum)
    }),
    await manifestCase('vector-head-outside-payload', MANIFEST_RULE, LOAD_FAILED, DISK, manifest => {
      const ref = fileRef(manifest, 0)
      ref.headOffset = Number(ref.bytes) - Number(ref.headLength)
    }),
    damagedCheckpoint('vector-head-sections-overlap', MANIFEST_RULE, LOAD_FAILED, DISK, {
      [DISK_FILE]: await withChangedHead(DISK, DISK_FILE, ({ head }) => {
        const section = headSection(head, 'docIds')
        section.length = Number(section.length) + OVERLAP_BYTES
      }),
    }),
    damagedCheckpoint('vector-head-section-outside-payload', MANIFEST_RULE, LOAD_FAILED, DISK, {
      [DISK_FILE]: await withChangedHead(DISK, DISK_FILE, ({ head }) => {
        const section = headSection(head, 'vectors')
        section.length = Number(section.length) + 4
      }),
    }),
    damagedCheckpoint('vector-page-checksum', MANIFEST_RULE, CRC_MISMATCH, DISK, {
      [DISK_FILE]: await withChangedHead(DISK, DISK_FILE, edit => {
        const bytes = sectionBytesOf(edit, headSection(edit.head, 'vectors'))
        bytes[0] = (bytes[0] ?? 0) ^ 0x01
      }),
    }),
    damagedCheckpoint('graph-node-offsets-descend', GRAPH_RULE, LOAD_FAILED, DISK, {
      [DISK_GRAPH]: await withChangedHead(DISK, DISK_GRAPH, edit =>
        changedNodeOffsets(edit, values => {
          values[1] = (values[2] ?? 0) + 4
        }),
      ),
    }),
    damagedCheckpoint('graph-node-offsets-past-neighbours', GRAPH_RULE, LOAD_FAILED, DISK, {
      [DISK_GRAPH]: await withChangedHead(DISK, DISK_GRAPH, edit =>
        changedNodeOffsets(edit, values => {
          values[values.length - 1] = Number(mapAt(firstGraphLayout(edit.head).neighbours, 'neighbours').length) + 4
        }),
      ),
    }),
    damagedCheckpoint('graph-list-past-next-offset', GRAPH_RULE, LOAD_FAILED, DISK, {
      [DISK_GRAPH]: await withChangedHead(DISK, DISK_GRAPH, neighboursListAfterFirstNode),
    }),
    damagedCheckpoint('vector-version', VECTOR_RULE, VERSION_MISMATCH, MEMORY, {
      [MEMORY_FILE]: await rewritten(await baseFile(MEMORY, MEMORY_FILE), 'vector-version', payload => {
        payload.v = 2
      }),
    }),
    await memoryGraphCase('graph-version', VERSION_MISMATCH, payload => {
      payload.v = 3
    }),
    await memoryGraphCase('graph-levels-length', LOAD_FAILED, payload => {
      const graph = firstGraph(payload)
      const levels = new Uint8Array(GRAPH_PART_VECTORS + 1)
      levels.set(bytesAt(graph.levels, 'levels'))
      graph.levels = levels
    }),
    await memoryGraphCase('graph-vector-in-two-graphs', LOAD_FAILED, payload => {
      const graphs = listAt(payload.graphs, 'graphs')
      graphs.push({ ...firstGraph(payload) })
    }),
    await memoryGraphCase('graph-calibrated-mean-negative', LOAD_FAILED, payload => {
      firstGraph(payload).calibratedMeanLength = -0.5
    }),
    await memoryGraphCase('graph-calibrated-mean-not-finite', LOAD_FAILED, payload => {
      firstGraph(payload).calibratedMeanLength = Number.NaN
    }),
    await memoryGraphCase('graph-neighbours-end-inside-a-list', LOAD_FAILED, payload => {
      const graph = firstGraph(payload)
      graph.neighbours = bytesAt(graph.neighbours, 'neighbours').slice(0, -4)
    }),
    await manifestCase('manifest-segment-length', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      const partition = mapAt(listAt(manifest.partitions, 'partitions')[0], 'partitions[0]')
      const ref = mapAt(listAt(partition.segments, 'segments')[1], 'segments[1]')
      ref.bytes = Number(ref.bytes) + 1
    }),
    await manifestCase('manifest-segment-checksum', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      const partition = mapAt(listAt(manifest.partitions, 'partitions')[0], 'partitions[0]')
      const ref = mapAt(listAt(partition.segments, 'segments')[1], 'segments[1]')
      ref.checksum = otherChecksum(ref.checksum)
    }),
    await manifestCase('manifest-segment-key', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      const partition = mapAt(listAt(manifest.partitions, 'partitions')[0], 'partitions[0]')
      const ref = mapAt(listAt(partition.segments, 'segments')[1], 'segments[1]')
      ref.key = `${MEMORY}/segments/0/s0000000000000007`
    }),
    await manifestCase('manifest-vector-file-length', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      const ref = fileRef(manifest, 1)
      ref.bytes = Number(ref.bytes) + 1
    }),
    await manifestCase('manifest-graph-part-checksum', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      const ref = graphRef(manifest)
      ref.checksum = otherChecksum(ref.checksum)
    }),
    await manifestCase('manifest-graph-part-key', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      graphRef(manifest).key = `${MEMORY}/${MEMORY_GRAPH.replace(/p0{16}$/, 'p0000000000000001')}`
    }),
    await manifestCase('manifest-dead-length', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      const ref = fileRef(manifest, 0)
      ref.dead = new Uint8Array([...bytesAt(ref.dead, 'dead'), 0])
    }),
    await manifestCase('manifest-vector-count-above-limit', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      fileRef(manifest, 1).count = 65_537
    }),
    await manifestCase('manifest-vector-count-differs', MANIFEST_RULE, LOAD_FAILED, MEMORY, manifest => {
      const ref = fileRef(manifest, 1)
      ref.count = Number(ref.count) + 1
    }),
  ]
}
