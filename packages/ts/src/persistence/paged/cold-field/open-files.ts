import { decode, decodeMulti } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { crc32 } from '../../../serialization/crc32'
import { HEADER_SIZE } from '../../../serialization/header'
import type { VectorMetric } from '../../../vector/brute-force'
import type { OsqBits } from '../../../vector/osq'
import type { FileRef, VectorFileRef } from '../../durability/segment/manifest'
import { decodeSections, type FileSection, loadFailed, RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES } from '../format'
import { readCacheOfThisThread } from '../read-cache'
import {
  closePagedFile,
  createSectionReader,
  openPagedFile,
  type PagedFile,
  readFileRange,
  readWholeSectionChecked,
  type SectionReader,
} from '../section-file'

const CODES_KEY_AND_MAP_HEADER_BYTES = 7
const BIN8_MAX_BYTES = 0xff
const BIN16_MAX_BYTES = 0xffff
const VECTOR_PAGE_SIZES: ReadonlySet<number> = new Set([SEGMENT_PAGE_BYTES, RECORD_PAGE_BYTES])
const NEIGHBOUR_PAGE_SIZES: ReadonlySet<number> = new Set([RECORD_PAGE_BYTES])
const LEVEL_PAGE_SIZES: ReadonlySet<number> = new Set([SEGMENT_PAGE_BYTES])

export interface ColdFileInput {
  ref: VectorFileRef
  path: string
}

export interface ColdGraphPartInput {
  ref: FileRef
  path: string
}

export interface ColdVectorFieldInput {
  fieldPath: string
  dimension: number
  metric: VectorMetric
  codeBits: OsqBits | null
  files: readonly ColdFileInput[]
  graphParts: readonly ColdGraphPartInput[]
  resolvePartition(docId: string): number | undefined
}

export interface ColdFile {
  readonly firstNumber: number
  readonly count: number
  readonly dead: Uint8Array | null
  readonly file: PagedFile
  readonly ids: SectionReader
  readonly idOffsets: SectionReader
  readonly idOrder: SectionReader
  readonly records: SectionReader | null
  readonly vectors: SectionReader
  readonly magnitudes: Float64Array
}

export interface ColdGraphPart {
  readonly file: PagedFile
  readonly levels: Uint8Array
  readonly nodeOffsets: Uint32Array
  readonly neighbours: SectionReader
}

export interface ColdCodes {
  bits: OsqBits
  centroid: Float32Array
}

export interface ColdGraph {
  readonly entryPoint: number | null
  readonly maxLayer: number
  readonly m: number
}

export interface OpenedFiles {
  files: ColdFile[]
  codes: ColdCodes | null
}

function readHead(path: string, ref: FileRef): Uint8Array | null {
  const { headOffset, headLength, headChecksum } = ref
  if (headOffset === undefined || headLength === undefined || headChecksum === undefined) return null
  const head = new Uint8Array(headLength)
  readFileRange(path, HEADER_SIZE + headOffset, head)
  if (crc32(head) !== headChecksum) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_CRC_MISMATCH,
      `The head of the file "${ref.key}" does not match its checksum`,
      { key: ref.key },
    )
  }
  return head
}

function decodedHead(head: Uint8Array, key: string): Record<string, unknown> {
  let raw: unknown
  try {
    raw = decode(head)
  } catch (error) {
    loadFailed(`The head of "${key}" is not MessagePack: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) loadFailed(`The head of "${key}" is not a map`)
  return raw as Record<string, unknown>
}

function binHeaderBytes(length: number): number {
  if (length <= BIN8_MAX_BYTES) return 2
  return length <= BIN16_MAX_BYTES ? 3 : 5
}

function isUint32OfThisHost(bytes: Uint8Array): boolean {
  return bytes.byteOffset % 4 === 0 && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
}

function uint32ValuesOf(bytes: Uint8Array): Uint32Array {
  if (isUint32OfThisHost(bytes)) return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  const values = new Uint32Array(bytes.byteLength / 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at < values.length; at++) values[at] = view.getUint32(at * 4, true)
  return values
}

function float64ValuesOf(bytes: Uint8Array): Float64Array {
  const values = new Float64Array(bytes.byteLength / 8)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at < values.length; at++) values[at] = view.getFloat64(at * 8, true)
  return values
}

export function codesOfFile(path: string, sections: Map<string, FileSection>, key: string): ColdCodes | null {
  const records = sections.get('records')
  const docIds = sections.get('docIds')
  if (records === undefined || docIds === undefined) return null
  const start = docIds.offset + docIds.length
  const length = records.offset - start - binHeaderBytes(records.length)
  if (length <= CODES_KEY_AND_MAP_HEADER_BYTES) loadFailed(`The file "${key}" places its codes before its IDs`)
  const bytes = new Uint8Array(length)
  readFileRange(path, HEADER_SIZE + start, bytes)
  const values: unknown[] = []
  try {
    for (const value of decodeMulti(bytes.subarray(CODES_KEY_AND_MAP_HEADER_BYTES))) values.push(value)
  } catch (error) {
    loadFailed(`The codes of "${key}" are not MessagePack: ${error instanceof Error ? error.message : String(error)}`)
  }
  const [bitsKey, bits, centroidKey, centroid] = values
  if (bitsKey !== 'bits' || centroidKey !== 'centroid' || !Array.isArray(centroid)) {
    loadFailed(`The file "${key}" holds its codes in another layout`)
  }
  if (bits !== 1 && bits !== 2 && bits !== 4 && bits !== 8)
    loadFailed(`The file "${key}" holds ${String(bits)} bit codes`)
  return { bits, centroid: Float32Array.from(centroid.map(Number)) }
}

function sameCodes(left: ColdCodes, right: ColdCodes): boolean {
  if (left.bits !== right.bits || left.centroid.length !== right.centroid.length) return false
  for (let at = 0; at < left.centroid.length; at++) if (left.centroid[at] !== right.centroid[at]) return false
  return true
}

function requiredSection(sections: Map<string, FileSection>, name: string, key: string): FileSection {
  const section = sections.get(name)
  if (section === undefined) loadFailed(`The head of "${key}" lists no section "${name}"`)
  return section
}

export function closeHeldFiles(held: ReadonlyArray<{ readonly file: PagedFile }>): void {
  for (const { file } of held) {
    file.cache.forgetFile(file.fileNumber)
    closePagedFile(file)
  }
}

function openOneFile(
  input: ColdVectorFieldInput,
  at: number,
  firstNumber: number,
  held: ColdFile[],
  codes: ColdCodes | null,
): ColdCodes | null | false {
  const { ref, path } = input.files[at]
  const head = readHead(path, ref)
  if (head === null) return false
  const sectionsRaw = decodedHead(head, ref.key).sections
  const list = decodeSections(sectionsRaw, ref.bytes - HEADER_SIZE, `head of "${ref.key}"`, VECTOR_PAGE_SIZES)
  const sections = new Map(list.map(section => [section.name, section]))
  const fileCodes = codesOfFile(path, sections, ref.key)
  if (input.codeBits !== null) {
    if (fileCodes === null || fileCodes.bits !== input.codeBits) return false
    if (codes !== null && !sameCodes(codes, fileCodes)) return false
  }
  const records = sections.get('records')
  const magnitudes = float64ValuesOf(
    readWholeSectionChecked(path, requiredSection(sections, 'magnitudes', ref.key), false),
  )
  if (magnitudes.length !== ref.count) loadFailed(`The file "${ref.key}" holds ${magnitudes.length} magnitudes`)
  const ids = requiredSection(sections, 'docIds', ref.key)
  const idOffsets = requiredSection(sections, 'idOffsets', ref.key)
  const idOrder = requiredSection(sections, 'idOrder', ref.key)
  const vectors = requiredSection(sections, 'vectors', ref.key)
  const file = openPagedFile(path, readCacheOfThisThread())
  held.push({
    firstNumber,
    count: ref.count,
    dead: ref.dead,
    file,
    ids: createSectionReader(file, ids),
    idOffsets: createSectionReader(file, idOffsets),
    idOrder: createSectionReader(file, idOrder),
    records: records === undefined ? null : createSectionReader(file, records),
    vectors: createSectionReader(file, vectors),
    magnitudes,
  })
  return input.codeBits === null ? null : fileCodes
}

export function openFiles(input: ColdVectorFieldInput): OpenedFiles | null {
  const files: ColdFile[] = []
  let codes: ColdCodes | null = null
  let firstNumber = 0
  try {
    for (let at = 0; at < input.files.length; at++) {
      const opened = openOneFile(input, at, firstNumber, files, codes)
      if (opened === false) {
        closeHeldFiles(files)
        return null
      }
      codes = opened
      firstNumber += input.files[at].ref.count
    }
  } catch (error) {
    closeHeldFiles(files)
    throw error
  }
  return { files, codes }
}

interface GraphLayout {
  entryPoint: unknown
  maxLayer: unknown
  m: unknown
  levels: FileSection
  nodeOffsets: Uint32Array
  neighbours: FileSection
}

function graphLayoutOf(head: Record<string, unknown>, ref: FileRef): GraphLayout | null {
  const { graphs } = head
  if (!Array.isArray(graphs) || graphs.length !== 1) return null
  const layout = graphs[0] as Record<string, unknown>
  const payloadLength = ref.bytes - HEADER_SIZE
  const [levels] = decodeSections([layout.levels], payloadLength, `head of "${ref.key}"`, LEVEL_PAGE_SIZES)
  const [neighbours] = decodeSections([layout.neighbours], payloadLength, `head of "${ref.key}"`, NEIGHBOUR_PAGE_SIZES)
  if (!(layout.nodeOffsets instanceof Uint8Array)) loadFailed(`The head of "${ref.key}" holds no node offsets`)
  const nodeOffsets = uint32ValuesOf(layout.nodeOffsets)
  if (nodeOffsets.length !== levels.length + 1) loadFailed(`The head of "${ref.key}" holds the wrong number of offsets`)
  for (let at = 1; at < nodeOffsets.length; at++) {
    if (nodeOffsets[at] < nodeOffsets[at - 1]) loadFailed(`The head of "${ref.key}" holds descending node offsets`)
  }
  if (nodeOffsets[nodeOffsets.length - 1] > neighbours.length) {
    loadFailed(`The node offsets of "${ref.key}" end outside its neighbour lists`)
  }
  return { entryPoint: layout.entryPoint, maxLayer: layout.maxLayer, m: layout.m, levels, nodeOffsets, neighbours }
}

export function openParts(input: ColdVectorFieldInput): { parts: ColdGraphPart[]; graph: ColdGraph } | null {
  const parts: ColdGraphPart[] = []
  let graph: ColdGraph | null = null
  try {
    for (const { ref, path } of input.graphParts) {
      const head = readHead(path, ref)
      const layout = head === null ? null : graphLayoutOf(decodedHead(head, ref.key), ref)
      if (layout === null) {
        closeHeldFiles(parts)
        return null
      }
      const { entryPoint, maxLayer, m } = layout
      if (typeof maxLayer !== 'number' || typeof m !== 'number') loadFailed(`The head of "${ref.key}" holds no layers`)
      if (entryPoint !== null && typeof entryPoint !== 'number') loadFailed(`The head of "${ref.key}" holds no entry`)
      if (graph === null) graph = { entryPoint, maxLayer, m }
      const levels = readWholeSectionChecked(path, layout.levels, false)
      const file = openPagedFile(path, readCacheOfThisThread())
      parts.push({
        file,
        levels,
        nodeOffsets: layout.nodeOffsets,
        neighbours: createSectionReader(file, layout.neighbours),
      })
    }
  } catch (error) {
    closeHeldFiles(parts)
    throw error
  }
  return graph === null ? null : { parts, graph }
}
