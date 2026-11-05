import { decode, encode } from '@msgpack/msgpack'
import { crc32 } from '../../../ts/src/serialization/crc32'
import { HEADER_SIZE } from '../../../ts/src/serialization/header'
import type { HeaderForm } from '../forms/header'
import { packedEnvelope } from '../reference/envelope'
import { listAt, mapAt, packedUint32s, type RawMap } from './bytes'

const PREFIX_BYTES = 8
const SECTION_ALIGNMENT = 4
const PAGED_HEADER: HeaderForm = { envelopeFormatVersion: 6, compression: 'none', checksum: true }

export interface PagedLayout {
  head: RawMap
  payload: Uint8Array
}

export interface PagedPacking {
  header?: HeaderForm
  headLength?: number
  headChecksum?: number
}

export function pagedLayoutOf(file: Uint8Array): PagedLayout {
  const payload = file.slice(HEADER_SIZE)
  const prefix = new DataView(payload.buffer, 0, PREFIX_BYTES)
  const headLength = prefix.getUint32(0, true)
  return { head: mapAt(decode(payload.subarray(PREFIX_BYTES, PREFIX_BYTES + headLength)), 'head'), payload }
}

export function sectionsOf(layout: PagedLayout): RawMap[] {
  return listAt(layout.head.sections, 'sections').map((section, at) => mapAt(section, `sections[${at}]`))
}

export function sectionNamed(layout: PagedLayout, name: string): RawMap {
  const section = sectionsOf(layout).find(candidate => candidate.name === name)
  if (section === undefined) throw new Error(`the paged segment holds no section ${name}`)
  return section
}

export function sectionBytes(layout: PagedLayout, name: string): Uint8Array {
  const section = sectionNamed(layout, name)
  const offset = Number(section.offset)
  return layout.payload.slice(offset, offset + Number(section.length))
}

export function withSectionBytes(layout: PagedLayout, name: string, bytes: Uint8Array): void {
  const section = sectionNamed(layout, name)
  if (bytes.byteLength !== Number(section.length)) throw new Error(`section ${name} changes its length`)
  layout.payload.set(bytes, Number(section.offset))
  const pageBytes = Number(section.pageBytes)
  const checksums: number[] = []
  for (let start = 0; start < bytes.byteLength; start += pageBytes) {
    checksums.push(crc32(bytes.subarray(start, start + pageBytes)))
  }
  section.checksums = packedUint32s(checksums)
}

function alignedAfterHead(headLength: number): number {
  const end = PREFIX_BYTES + headLength
  return Math.ceil(end / SECTION_ALIGNMENT) * SECTION_ALIGNMENT
}

export async function packedPaged(layout: PagedLayout, packing: PagedPacking = {}): Promise<Uint8Array> {
  const sections = sectionsOf(layout)
  const sectionsStart = Math.min(...sections.map(section => Number(section.offset)))
  let shift = 0
  let head = encode(layout.head)
  while (alignedAfterHead(head.byteLength) > sectionsStart + shift) {
    const added = alignedAfterHead(head.byteLength) - (sectionsStart + shift)
    shift += added
    for (const section of sections) section.offset = Number(section.offset) + added
    head = encode(layout.head)
  }
  const body = layout.payload.subarray(sectionsStart)
  const payload = new Uint8Array(sectionsStart + shift + body.byteLength)
  const prefix = new DataView(payload.buffer, 0, PREFIX_BYTES)
  prefix.setUint32(0, packing.headLength ?? head.byteLength, true)
  prefix.setUint32(4, packing.headChecksum ?? crc32(head), true)
  payload.set(head, PREFIX_BYTES)
  payload.set(body, sectionsStart + shift)
  return packedEnvelope([payload], packing.header ?? PAGED_HEADER)
}
