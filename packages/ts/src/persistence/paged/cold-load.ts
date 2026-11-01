import { decode } from '@msgpack/msgpack'
import { HEADER_SIZE } from '../../serialization/header'
import { VECTOR_FILE_PAYLOAD_VERSION } from '../../vector/vector-index/checkpoint-payload'
import type { VectorCheckpointRestore } from '../../vector/vector-index/checkpoint-restore'
import { bytesToVectors } from '../../vector/vector-index/payload'
import { type ColdFileInput, codesOfFile } from './cold-field'
import { COLD_LOAD_DELAY_MS } from './constants'
import { decodeSections, type FileSection, loadFailed, RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES } from './format'
import { checkEverySectionPage, readFileRange, readWholeSectionChecked } from './section-file'

const FILE_PAGE_SIZES: ReadonlySet<number> = new Set([SEGMENT_PAGE_BYTES, RECORD_PAGE_BYTES])
const FLOAT32_BYTES = 4
const FLOAT64_BYTES = 8

function yieldToSearches(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export function waitBeforeColdLoad(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, COLD_LOAD_DELAY_MS).unref()
  })
}

function sectionsOfFile(input: ColdFileInput): Map<string, FileSection> {
  const { ref, path } = input
  const { headOffset, headLength } = ref
  if (headOffset === undefined || headLength === undefined) loadFailed(`The vector file "${ref.key}" holds no head`)
  const head = new Uint8Array(headLength)
  readFileRange(path, HEADER_SIZE + headOffset, head)
  const raw = decode(head) as { sections?: unknown }
  const list = decodeSections(raw.sections, ref.bytes - HEADER_SIZE, `head of "${ref.key}"`, FILE_PAGE_SIZES)
  return new Map(list.map(section => [section.name, section]))
}

function requiredSection(sections: Map<string, FileSection>, name: string, key: string): FileSection {
  const section = sections.get(name)
  if (section === undefined) loadFailed(`The head of "${key}" lists no section "${name}"`)
  return section
}

function magnitudesOf(bytes: Uint8Array): Float64Array {
  const values = new Float64Array(bytes.byteLength / FLOAT64_BYTES)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at < values.length; at++) values[at] = view.getFloat64(at * FLOAT64_BYTES, true)
  return values
}

export async function loadFilesByParts(
  files: readonly ColdFileInput[],
  restore: VectorCheckpointRestore,
  fieldPath: string,
  dimension: number,
  stillWanted: () => boolean,
): Promise<void> {
  for (const input of files) {
    await yieldToSearches()
    if (!stillWanted()) return
    const { ref, path } = input
    const sections = sectionsOfFile(input)
    const idBytes = readWholeSectionChecked(path, requiredSection(sections, 'docIds', ref.key), false)
    const docIds = decode(idBytes)
    if (!Array.isArray(docIds) || docIds.length !== ref.count) {
      loadFailed(`The vector file "${ref.key}" lists the wrong number of IDs`)
    }
    const recordSection = sections.get('records')
    const records = recordSection === undefined ? null : readWholeSectionChecked(path, recordSection, false)
    const magnitudes = magnitudesOf(
      readWholeSectionChecked(path, requiredSection(sections, 'magnitudes', ref.key), false),
    )
    const vectorSection = requiredSection(sections, 'vectors', ref.key)
    const stride = dimension * FLOAT32_BYTES
    await checkEverySectionPage(path, vectorSection, stillWanted)
    if (!stillWanted()) return
    const fileCodes = codesOfFile(path, sections, ref.key)
    restore.addFile({
      id: ref.id,
      key: ref.key,
      payload: {
        v: VECTOR_FILE_PAYLOAD_VERSION,
        fieldName: fieldPath,
        dimension,
        docIds: docIds as string[],
        codes:
          records === null || fileCodes === null
            ? null
            : { bits: fileCodes.bits, centroid: Array.from(fileCodes.centroid), records },
        vectors: new Uint8Array(0),
      },
      dead: ref.dead,
      location: { path, vectorsOffset: HEADER_SIZE + vectorSection.offset },
      byParts: {
        magnitudes,
        vectorAt(position) {
          const bytes = new Uint8Array(stride)
          readFileRange(path, HEADER_SIZE + vectorSection.offset + position * stride, bytes)
          return bytesToVectors(bytes)
        },
      },
    })
  }
  await yieldToSearches()
  if (stillWanted()) restore.finish()
}
