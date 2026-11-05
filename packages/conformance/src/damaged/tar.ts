import { joined } from '../reference/envelope'

const TAR_BLOCK_BYTES = 512
const NAME_BYTES = 100
const MODE_OFFSET = 100
const UID_OFFSET = 108
const GID_OFFSET = 116
const SIZE_OFFSET = 124
const MTIME_OFFSET = 136
const CHECKSUM_OFFSET = 148
const CHECKSUM_BYTES = 8
const TYPEFLAG_OFFSET = 156
const MAGIC_OFFSET = 257
const VERSION_OFFSET = 263
const SIZE_DIGITS = 11
const SMALL_FIELD_DIGITS = 7
const CHECKSUM_DIGITS = 6
const SPACE = 0x20
const END_OF_ARCHIVE_BLOCKS = 2

export const REGULAR_FILE = 0x30
export const SYMBOLIC_LINK = 0x32
export const DIRECTORY = 0x35

export interface TarEntry {
  name: string
  bytes: Uint8Array
  type?: number
  declaredSize?: number
}

function written(block: Uint8Array, offset: number, text: string): void {
  block.set(new TextEncoder().encode(text), offset)
}

function octal(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, '0')}\0`
}

function headerOf(entry: TarEntry): Uint8Array {
  const name = new TextEncoder().encode(entry.name)
  if (name.byteLength > NAME_BYTES) throw new Error(`the tar entry name ${entry.name} passes ${NAME_BYTES} bytes`)
  const block = new Uint8Array(TAR_BLOCK_BYTES)
  block.set(name, 0)
  written(block, MODE_OFFSET, octal(0o644, SMALL_FIELD_DIGITS))
  written(block, UID_OFFSET, octal(0, SMALL_FIELD_DIGITS))
  written(block, GID_OFFSET, octal(0, SMALL_FIELD_DIGITS))
  written(block, SIZE_OFFSET, octal(entry.declaredSize ?? entry.bytes.byteLength, SIZE_DIGITS))
  written(block, MTIME_OFFSET, octal(0, SIZE_DIGITS))
  block[TYPEFLAG_OFFSET] = entry.type ?? REGULAR_FILE
  written(block, MAGIC_OFFSET, 'ustar\0')
  written(block, VERSION_OFFSET, '00')
  block.fill(SPACE, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_BYTES)
  const sum = block.reduce((total, byte) => total + byte, 0)
  written(block, CHECKSUM_OFFSET, `${octal(sum, CHECKSUM_DIGITS)} `)
  return block
}

function padded(bytes: Uint8Array): Uint8Array {
  const blocks = Math.ceil(bytes.byteLength / TAR_BLOCK_BYTES)
  const body = new Uint8Array(blocks * TAR_BLOCK_BYTES)
  body.set(bytes)
  return body
}

export function tarOf(entries: readonly TarEntry[], ends = true): Uint8Array {
  const chunks = entries.flatMap(entry => [headerOf(entry), padded(entry.bytes)])
  if (ends) chunks.push(new Uint8Array(TAR_BLOCK_BYTES * END_OF_ARCHIVE_BLOCKS))
  return joined(chunks)
}
