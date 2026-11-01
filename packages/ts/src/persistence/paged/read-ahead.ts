import { decode } from '@msgpack/msgpack'
import { HEADER_SIZE } from '../../serialization/header'
import type { DurableDirectory } from '../durability/durable-filesystem'
import type { FileRef, SegmentManifest } from '../durability/segment/manifest'
import { READ_AHEAD_CHUNK_BYTES, READS_AHEAD_AT_ONCE } from './constants'
import { decodeSections, type FileSection, RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES } from './format'
import { residentSectionsOf } from './resident'
import { readFileRangeLater } from './section-file'
import { isPagedSegmentFile, pagedListingOf } from './verify'

const FILE_PAGE_SIZES: ReadonlySet<number> = new Set([SEGMENT_PAGE_BYTES, RECORD_PAGE_BYTES])

interface FileRange {
  path: string
  offset: number
  length: number
}

function rangeOf(path: string, section: FileSection): FileRange {
  return { path, offset: HEADER_SIZE + section.offset, length: section.length }
}

async function readRangesAhead(ranges: readonly FileRange[]): Promise<void> {
  let rangeAt = 0
  let doneInRange = 0

  function nextChunk(): FileRange | null {
    while (rangeAt < ranges.length && doneInRange >= ranges[rangeAt].length) {
      rangeAt += 1
      doneInRange = 0
    }
    if (rangeAt >= ranges.length) return null
    const { path, offset, length } = ranges[rangeAt]
    const chunk = { path, offset: offset + doneInRange, length: Math.min(READ_AHEAD_CHUNK_BYTES, length - doneInRange) }
    doneInRange += chunk.length
    return chunk
  }

  async function readChunks(): Promise<void> {
    const scratch = new Uint8Array(READ_AHEAD_CHUNK_BYTES)
    for (let chunk = nextChunk(); chunk !== null; chunk = nextChunk()) {
      const target = scratch.subarray(0, chunk.length)
      if (!(await readFileRangeLater(chunk.path, chunk.offset, target))) return
    }
  }

  await Promise.all(Array.from({ length: READS_AHEAD_AT_ONCE }, readChunks))
}

async function headOf(path: string, ref: FileRef): Promise<Record<string, unknown> | null> {
  const { headOffset, headLength } = ref
  if (headOffset === undefined || headLength === undefined) return null
  const head = new Uint8Array(headLength)
  if (!(await readFileRangeLater(path, HEADER_SIZE + headOffset, head))) return null
  return decode(head) as Record<string, unknown>
}

async function magnitudesOfFile(directory: DurableDirectory, ref: FileRef): Promise<FileRange[]> {
  const path = await directory.pathOf(ref.key)
  const head = await headOf(path, ref)
  if (head === null) return []
  const sections = decodeSections(head.sections, ref.bytes - HEADER_SIZE, `head of "${ref.key}"`, FILE_PAGE_SIZES)
  return sections.filter(section => section.name === 'magnitudes').map(section => rangeOf(path, section))
}

async function levelsOfPart(directory: DurableDirectory, ref: FileRef): Promise<FileRange[]> {
  const path = await directory.pathOf(ref.key)
  const head = await headOf(path, ref)
  const graphs = head?.graphs
  if (!Array.isArray(graphs) || graphs.length !== 1) return []
  const { levels } = graphs[0] as { levels: unknown }
  return decodeSections([levels], ref.bytes - HEADER_SIZE, `head of "${ref.key}"`, FILE_PAGE_SIZES).map(section =>
    rangeOf(path, section),
  )
}

async function residentSectionsOfSegment(directory: DurableDirectory, ref: FileRef): Promise<FileRange[]> {
  if (!(await isPagedSegmentFile(directory, ref.key))) return []
  const listing = await pagedListingOf(directory, ref)
  return residentSectionsOf(listing).map(section => rangeOf(listing.path, section))
}

export async function readOpeningSectionsAhead(directory: DurableDirectory, manifest: SegmentManifest): Promise<void> {
  try {
    const groups = await Promise.all([
      ...manifest.partitions.flatMap(partition =>
        partition.segments.map(ref => residentSectionsOfSegment(directory, ref)),
      ),
      ...manifest.vectors.flatMap(field => [
        ...field.files.map(ref => magnitudesOfFile(directory, ref)),
        ...field.graphParts.map(ref => levelsOfPart(directory, ref)),
      ]),
    ])
    await readRangesAhead(groups.flat())
  } catch {
    return
  }
}
