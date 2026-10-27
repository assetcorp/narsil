import { crc32 } from 'node:zlib'
import { encode } from '@msgpack/msgpack'
import { bytesOf, envelopePayload } from './saved-graph-walk'

const TAR_BLOCK_BYTES = 512
const TAR_NAME_BYTES = 100
const TAR_SIZE_OFFSET = 124
const TAR_SIZE_BYTES = 12
const TAR_SIZE_DIGITS = 11
const TAR_CHECKSUM_OFFSET = 148
const TAR_CHECKSUM_BYTES = 8
const TAR_CHECKSUM_DIGITS = 6
const TAR_TYPE_OFFSET = 156
const TAR_PREFIX_OFFSET = 345
const TAR_PREFIX_BYTES = 155
const PAX_HEADER_TYPE = 'x'
const ASCII_SPACE = 0x20
const ENVELOPE_HEADER_BYTES = 32
const ENVELOPE_LENGTH_OFFSET = 8
const ENVELOPE_FLAGS_OFFSET = 12
const ENVELOPE_CHECKSUM_OFFSET = 14
const CHECKSUM_PRESENT_FLAG = 0b1000

interface ArchiveEntry {
  name: string
  header: Uint8Array
  extendedHeader: Uint8Array | null
  body: Uint8Array
}

interface SavedField {
  fieldPath: string
  graphParts: Array<{ key: string; bytes: number; checksum: number }>
}

interface SavedGraphPart {
  graphs: Array<{ entryPoint: number | null; m: number; levels: Uint8Array; neighbours: Uint8Array }>
}

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function paddedLength(size: number): number {
  return Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
}

function readEntries(archive: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let at = 0
  let extendedHeader: Uint8Array | null = null
  let longName: string | null = null
  while (at + TAR_BLOCK_BYTES <= archive.length) {
    const header = archive.slice(at, at + TAR_BLOCK_BYTES)
    if (header.every(byte => byte === 0)) break
    const size = Number.parseInt(text(header.subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_BYTES)).trim(), 8)
    const body = archive.slice(at + TAR_BLOCK_BYTES, at + TAR_BLOCK_BYTES + size)
    const block = archive.slice(at, at + TAR_BLOCK_BYTES + paddedLength(size))
    at += block.length
    if (String.fromCharCode(header[TAR_TYPE_OFFSET]) === PAX_HEADER_TYPE) {
      extendedHeader = block
      longName = /\d+ path=(.*)\n/.exec(new TextDecoder().decode(body))?.[1] ?? null
      continue
    }
    const prefix = text(header.subarray(TAR_PREFIX_OFFSET, TAR_PREFIX_OFFSET + TAR_PREFIX_BYTES))
    const shortName = text(header.subarray(0, TAR_NAME_BYTES))
    const name = longName ?? (prefix.length > 0 ? `${prefix}/${shortName}` : shortName)
    entries.push({ name, header, extendedHeader, body })
    extendedHeader = null
    longName = null
  }
  return entries
}

function headerFor(header: Uint8Array, size: number): Uint8Array {
  const rewritten = header.slice()
  const digits = size.toString(8).padStart(TAR_SIZE_DIGITS, '0')
  rewritten.set(new TextEncoder().encode(`${digits}\0`), TAR_SIZE_OFFSET)
  rewritten.fill(ASCII_SPACE, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES)
  const sum = rewritten.reduce((total, byte) => total + byte, 0)
  rewritten.set(
    new TextEncoder().encode(`${sum.toString(8).padStart(TAR_CHECKSUM_DIGITS, '0')}\0 `),
    TAR_CHECKSUM_OFFSET,
  )
  return rewritten
}

function writeEntries(entries: ArchiveEntry[]): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = []
  for (const entry of entries) {
    if (entry.extendedHeader !== null) blocks.push(entry.extendedHeader)
    blocks.push(headerFor(entry.header, entry.body.length))
    const padded = new Uint8Array(paddedLength(entry.body.length))
    padded.set(entry.body)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(TAR_BLOCK_BYTES * 2))
  const archive = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0))
  let at = 0
  for (const block of blocks) {
    archive.set(block, at)
    at += block.length
  }
  return archive
}

function rewrapped(original: Uint8Array, payload: unknown): Uint8Array {
  const encoded = encode(payload)
  const file = new Uint8Array(ENVELOPE_HEADER_BYTES + encoded.length)
  file.set(original.subarray(0, ENVELOPE_HEADER_BYTES))
  file.set(encoded, ENVELOPE_HEADER_BYTES)
  const view = new DataView(file.buffer)
  view.setUint32(ENVELOPE_LENGTH_OFFSET, encoded.length, false)
  view.setUint16(ENVELOPE_FLAGS_OFFSET, CHECKSUM_PRESENT_FLAG, false)
  view.setUint32(ENVELOPE_CHECKSUM_OFFSET, crc32(encoded), false)
  return file
}

type BaseListEdit = (number: number, list: number[]) => number[]

function withBaseLists(neighbours: Uint8Array, levels: Uint8Array, edit: BaseListEdit): Uint8Array {
  const view = new DataView(neighbours.buffer, neighbours.byteOffset, neighbours.byteLength)
  const words: number[] = []
  let word = 0
  levels.forEach((layers, number) => {
    for (let layer = 0; layer < layers; layer++) {
      const count = view.getUint32(word * 4, true)
      const list: number[] = []
      for (let i = 1; i <= count; i++) list.push(view.getUint32((word + i) * 4, true))
      const kept = layer === 0 ? edit(number, list) : list
      words.push(kept.length, ...kept)
      word += count + 1
    }
  })
  const rewritten = new Uint8Array(words.length * 4)
  const out = new DataView(rewritten.buffer)
  for (let index = 0; index < words.length; index++) out.setUint32(index * 4, words[index], true)
  return rewritten
}

function baseNodesOf(part: SavedGraphPart): number[] {
  const nodes: number[] = []
  const graph = part.graphs[0]
  graph?.levels.forEach((layers, number) => {
    if (layers === 1 && number !== graph.entryPoint) nodes.push(number)
  })
  return nodes
}

export async function snapshotWithoutLinksTo(
  snapshot: ReadableStream<Uint8Array>,
  fieldPath: string,
  choose: (baseNodes: number[]) => number[],
): Promise<{ archive: Uint8Array<ArrayBuffer>; cut: number[] }> {
  let cut: number[] = []
  const archive = await withEditedGraphPart(snapshot, fieldPath, part => {
    cut = choose(baseNodesOf(part))
    const cutSet = new Set(cut)
    const edit: BaseListEdit = (_, list) => list.filter(number => !cutSet.has(number))
    for (const graph of part.graphs) graph.neighbours = withBaseLists(graph.neighbours, graph.levels, edit)
  })
  return { archive, cut }
}

export async function snapshotWithBaseLists(
  snapshot: ReadableStream<Uint8Array>,
  fieldPath: string,
  layout: (baseListLimit: number) => { entryPoint: number; baseListOf: (number: number) => number[] },
): Promise<Uint8Array<ArrayBuffer>> {
  return withEditedGraphPart(snapshot, fieldPath, part => {
    const graph = part.graphs[0]
    if (graph === undefined || part.graphs.length !== 1) throw new Error('the part holds no single graph')
    const { entryPoint, baseListOf } = layout(graph.m * 2)
    graph.entryPoint = entryPoint
    graph.neighbours = withBaseLists(graph.neighbours, graph.levels, number => baseListOf(number))
  })
}

async function withEditedGraphPart(
  snapshot: ReadableStream<Uint8Array>,
  fieldPath: string,
  edit: (part: SavedGraphPart) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const entries = readEntries(await bytesOf(snapshot))
  const manifestEntry = entries.find(entry => entry.name === 'manifest')
  if (manifestEntry === undefined) throw new Error('the archive holds no manifest')
  const manifest = envelopePayload(manifestEntry.body) as { vectors: SavedField[] }
  const field = manifest.vectors.find(vectors => vectors.fieldPath === fieldPath)
  if (field === undefined || field.graphParts.length !== 1) throw new Error('the field holds no single graph part')
  const partRef = field.graphParts[0]
  const partEntry = entries.find(entry => partRef.key.endsWith(`/${entry.name}`))
  if (partEntry === undefined) throw new Error(`the archive lacks ${partRef.key}`)

  const part = envelopePayload(partEntry.body) as SavedGraphPart
  edit(part)
  partEntry.body = rewrapped(partEntry.body, part)

  partRef.bytes = partEntry.body.length
  partRef.checksum = new DataView(partEntry.body.buffer).getUint32(ENVELOPE_CHECKSUM_OFFSET, false)
  manifestEntry.body = rewrapped(manifestEntry.body, manifest)
  return writeEntries(entries)
}
