import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { manifestKey } from '../../../persistence/durability/segment/layout'
import { encodeSegmentManifest } from '../../../persistence/durability/segment/manifest-encode'
import { directoryCheckpointStore } from '../../../persistence/durability/segment/store'
import { crc32 } from '../../../serialization/crc32'
import { requireManifestOnDisk } from '../../persistence/durability/manifest-on-disk'

const HEADER_BYTES = 32
const PREFIX_BYTES = 8

interface Section {
  name: string
  offset: number
  length: number
  pageBytes: number
  checksums: Uint8Array
}

export async function corruptRemovalToken(directory: string, token: number): Promise<void> {
  const durable = createDurableDirectory(directory)
  const store = directoryCheckpointStore(durable)
  const manifest = await requireManifestOnDisk(directory, 'articles')
  const ref = manifest.partitions.flatMap(partition => partition.segments)[0]
  if (ref === undefined) throw new Error('The checkpoint wrote no segment')
  const path = join(directory, ref.key)
  const bytes = await readFile(path)
  const headLength = bytes.readUInt32LE(HEADER_BYTES)
  const headStart = HEADER_BYTES + PREFIX_BYTES
  const head = decode(bytes.subarray(headStart, headStart + headLength)) as { sections: Section[] }
  const section = head.sections.find(entry => entry.name === 'removals')
  if (section === undefined || section.length < 16) throw new Error('The segment holds too few removal entries')
  const start = HEADER_BYTES + section.offset
  bytes.writeUInt32LE(token, start + 8)
  const page = bytes.subarray(start, start + Math.min(section.pageBytes, section.length))
  new DataView(section.checksums.buffer, section.checksums.byteOffset, section.checksums.byteLength).setUint32(
    0,
    crc32(page),
    true,
  )
  const replacement = encode(head)
  if (replacement.length !== headLength) throw new Error('The amended head changed length')
  bytes.set(replacement, headStart)
  bytes.writeUInt32LE(crc32(replacement), HEADER_BYTES + 4)
  ref.checksum = crc32(bytes.subarray(HEADER_BYTES))
  bytes.writeUInt32BE(ref.checksum, 14)
  await writeFile(path, bytes)
  const encodedManifest = await encodeSegmentManifest(manifest)
  await store.write(manifestKey('articles'), encodedManifest.chunks)
}
