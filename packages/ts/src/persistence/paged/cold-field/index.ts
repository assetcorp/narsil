import { decode } from '@msgpack/msgpack'
import { compareCodePoints } from '../../../core/ordering'
import type { VectorMetric } from '../../../vector/brute-force'
import { isDead } from '../../../vector/vector-index/dead-bits'
import { bytesToVectors } from '../../../vector/vector-index/payload'
import type { ColdVectorField } from '../../../vector/vector-index/shared'
import { searchColdGraph, searchColdGraphConcurrently } from '../cold-search'
import { loadFailed } from '../format'
import type { SectionReader } from '../section-file'
import {
  type ColdCodes,
  type ColdFile,
  type ColdGraph,
  type ColdGraphPart,
  type ColdVectorFieldInput,
  closeHeldFiles,
  type OpenedFiles,
  openFiles,
  openParts,
} from './open-files'

export type {
  ColdCodes,
  ColdFile,
  ColdFileInput,
  ColdGraph,
  ColdGraphPart,
  ColdGraphPartInput,
  ColdVectorFieldInput,
} from './open-files'
export { codesOfFile } from './open-files'

export const COLD_GRAPH_PART_VECTORS = 16_384

export interface ColdFieldData {
  readonly dimension: number
  readonly metric: VectorMetric
  readonly total: number
  readonly codes: ColdCodes | null
  readonly graph: ColdGraph
  readonly files: readonly ColdFile[]
  readonly parts: readonly ColdGraphPart[]
  fileOfNumber(number: number): ColdFile
  topLayerOf(number: number): number
  idAt(number: number): string
  vectorAt(number: number): Float32Array
  magnitudeAt(number: number): number
  isDeadNumber(number: number): boolean
  fetchRows(
    numbers: readonly number[],
    sectionOf: (file: ColdFile) => SectionReader | null,
    rowBytes: number,
  ): Promise<unknown> | null
}

function everyLiveVectorHoldsANode(files: readonly ColdFile[], parts: readonly ColdGraphPart[]): boolean {
  for (const file of files) {
    for (let at = 0; at < file.count; at++) {
      if (isDead(file.dead, at)) continue
      const number = file.firstNumber + at
      const part = parts[Math.floor(number / COLD_GRAPH_PART_VECTORS)]
      if (part === undefined) return false
      if (part.levels[number % COLD_GRAPH_PART_VECTORS] === 0) return false
    }
  }
  return true
}

function createFieldData(
  input: ColdVectorFieldInput,
  opened: OpenedFiles,
  graph: ColdGraph,
  parts: readonly ColdGraphPart[],
): ColdFieldData {
  const { files, codes } = opened
  const lastFile = files[files.length - 1]
  const total = lastFile === undefined ? 0 : lastFile.firstNumber + lastFile.count

  function fileOfNumber(number: number): ColdFile {
    let low = 0
    let high = files.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (files[middle].firstNumber <= number) low = middle
      else high = middle - 1
    }
    return files[low]
  }

  function idInFile(file: ColdFile, position: number): string {
    const offsets = new Uint8Array(8)
    file.idOffsets.read(position * 4, offsets)
    const view = new DataView(offsets.buffer)
    const start = view.getUint32(0, true)
    const end = view.getUint32(4, true)
    if (end < start) loadFailed(`The ID offsets of "${file.file.path}" descend at position ${position}`)
    const id = decode(file.ids.bytesAt(start, end - start))
    if (typeof id !== 'string') loadFailed(`Position ${position} of "${file.file.path}" holds no ID`)
    return id
  }

  return {
    dimension: input.dimension,
    metric: input.metric,
    total,
    codes,
    graph,
    files,
    parts,
    fileOfNumber,
    topLayerOf(number) {
      const part = parts[Math.floor(number / COLD_GRAPH_PART_VECTORS)]
      if (part === undefined) return -1
      const at = number % COLD_GRAPH_PART_VECTORS
      return at < part.levels.length ? part.levels[at] - 1 : -1
    },
    idAt(number) {
      const file = fileOfNumber(number)
      return idInFile(file, number - file.firstNumber)
    },
    vectorAt(number) {
      const file = fileOfNumber(number)
      const stride = input.dimension * 4
      const bytes = new Uint8Array(stride)
      file.vectors.read((number - file.firstNumber) * stride, bytes)
      return bytesToVectors(bytes)
    },
    magnitudeAt(number) {
      const file = fileOfNumber(number)
      return file.magnitudes[number - file.firstNumber]
    },
    isDeadNumber(number) {
      const file = fileOfNumber(number)
      return isDead(file.dead, number - file.firstNumber)
    },
    fetchRows(numbers, sectionOf, rowBytes) {
      const positionsByFile = new Map<ColdFile, number[]>()
      for (const number of numbers) {
        const file = fileOfNumber(number)
        const positions = positionsByFile.get(file)
        const position = (number - file.firstNumber) * rowBytes
        if (positions === undefined) positionsByFile.set(file, [position])
        else positions.push(position)
      }
      const reads: Array<Promise<unknown>> = []
      for (const [file, positions] of positionsByFile) {
        const read = sectionOf(file)?.fetchRows(positions, rowBytes) ?? null
        if (read !== null) reads.push(read)
      }
      return reads.length === 0 ? null : Promise.all(reads)
    },
  }
}

function positionOfId(file: ColdFile, docId: string, idAt: (number: number) => string): number | undefined {
  let low = 0
  let high = file.count - 1
  const slot = new Uint8Array(4)
  const view = new DataView(slot.buffer)
  while (low <= high) {
    const middle = (low + high) >> 1
    file.idOrder.read(middle * 4, slot)
    const position = view.getUint32(0, true)
    if (position >= file.count) loadFailed(`The ID order of "${file.file.path}" holds position ${position}`)
    const order = compareCodePoints(idAt(file.firstNumber + position), docId)
    if (order === 0) return position
    if (order < 0) low = middle + 1
    else high = middle - 1
  }
  return undefined
}

export function openColdVectorField(input: ColdVectorFieldInput): ColdVectorField | null {
  const opened = openFiles(input)
  if (opened === null) return null
  let graphed: ReturnType<typeof openParts>
  try {
    graphed = openParts(input)
  } catch (error) {
    closeHeldFiles(opened.files)
    throw error
  }
  if (graphed === null) {
    closeHeldFiles(opened.files)
    return null
  }
  const { parts, graph } = graphed
  function closeAll(): void {
    closeHeldFiles(opened?.files ?? [])
    closeHeldFiles(parts)
  }
  if (!everyLiveVectorHoldsANode(opened.files, parts)) {
    closeAll()
    return null
  }
  const data = createFieldData(input, opened, graph, parts)
  let live = 0
  for (const file of opened.files) {
    for (let at = 0; at < file.count; at++) if (!isDead(file.dead, at)) live += 1
  }
  let residentBytes = 0
  for (const file of opened.files) residentBytes += file.magnitudes.byteLength
  for (const part of parts) residentBytes += part.levels.byteLength + part.nodeOffsets.byteLength

  function liveNumberOf(docId: string): number | undefined {
    for (let at = data.files.length; at > 0; at--) {
      const file = data.files[at - 1]
      const position = positionOfId(file, docId, data.idAt)
      if (position !== undefined && !isDead(file.dead, position)) return file.firstNumber + position
    }
    return undefined
  }

  return {
    liveCount: live,
    residentBytes,
    numberOf: liveNumberOf,
    vectorOfNumber: number => data.vectorAt(number),
    magnitudeOfNumber: number => data.magnitudeAt(number),
    partitionOf: docId => input.resolvePartition(docId),
    filePaths: () => [...input.files, ...input.graphParts].map(file => file.path),
    search: (query, k, options, accepts, excluded) => searchColdGraph(data, query, k, options, accepts, excluded),
    searchConcurrently: (query, k, options, accepts, excluded) =>
      searchColdGraphConcurrently(data, query, k, options, accepts, excluded),
    close: closeAll,
  }
}
