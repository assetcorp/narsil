import { decode, encode } from '@msgpack/msgpack'
import { crc32 } from '../../../ts/src/serialization/crc32'
import { HEADER_SIZE } from '../../../ts/src/serialization/header'
import { baseFile, listAt, mapAt, packedUint32s, type RawMap, rewritten, withPayloadChecksum } from './bytes'

async function listedRef(indexName: string, relative: string): Promise<RawMap> {
  let found: RawMap | undefined
  await rewritten(await baseFile(indexName, 'manifest'), 'manifest', manifest => {
    for (const field of listAt(manifest.vectors, 'vectors')) {
      const vectors = mapAt(field, 'vector field')
      for (const ref of [...listAt(vectors.files, 'files'), ...listAt(vectors.graphParts, 'graphParts')]) {
        const map = mapAt(ref, 'ref')
        if (map.key === `${indexName}/${relative}`) found = map
      }
    }
  })
  if (found === undefined) throw new Error(`the ${indexName} manifest lists no ${relative}`)
  return found
}

export interface HeadEdit {
  head: RawMap
  file: Uint8Array
}

export async function withChangedHead(
  indexName: string,
  relative: string,
  change: (edit: HeadEdit) => void,
): Promise<Uint8Array> {
  const file = (await baseFile(indexName, relative)).slice()
  const ref = await listedRef(indexName, relative)
  const start = HEADER_SIZE + Number(ref.headOffset)
  const length = Number(ref.headLength)
  const head = mapAt(decode(file.subarray(start, start + length)), 'head')
  change({ head, file })
  const encoded = encode(head)
  if (encoded.byteLength !== length) throw new Error(`the changed head of ${relative} changes its length`)
  file.set(encoded, start)
  return withPayloadChecksum(file)
}

export function sectionBytesOf(edit: HeadEdit, section: RawMap): Uint8Array {
  const from = HEADER_SIZE + Number(section.offset)
  return edit.file.subarray(from, from + Number(section.length))
}

export function withFreshPageChecksums(edit: HeadEdit, section: RawMap): void {
  const bytes = sectionBytesOf(edit, section)
  const pageBytes = Number(section.pageBytes)
  const checksums: number[] = []
  for (let start = 0; start < bytes.byteLength; start += pageBytes) {
    checksums.push(crc32(bytes.subarray(start, start + pageBytes)))
  }
  section.checksums = packedUint32s(checksums)
}

export function headSection(head: RawMap, name: string): RawMap {
  const found = listAt(head.sections, 'sections')
    .map(entry => mapAt(entry, 'section'))
    .find(entry => entry.name === name)
  if (found === undefined) throw new Error(`the head lists no section ${name}`)
  return found
}

export function firstGraphLayout(head: RawMap): RawMap {
  return mapAt(listAt(head.graphs, 'graphs')[0], 'graphs[0]')
}
