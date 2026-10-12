import { ErrorCodes, NarsilError } from '../../errors'

export const TAR_BLOCK_BYTES = 512
const NAME_OFFSET = 0
const NAME_BYTES = 100
const MODE_OFFSET = 100
const OWNER_OFFSET = 108
const GROUP_OFFSET = 116
const ID_FIELD_BYTES = 8
const SIZE_OFFSET = 124
const SIZE_FIELD_BYTES = 12
const SIZE_FIELD_DIGITS = 11
const MTIME_OFFSET = 136
const MTIME_FIELD_BYTES = 12
const CHECKSUM_FIELD_OFFSET = 148
const CHECKSUM_FIELD_BYTES = 8
const CHECKSUM_DIGITS = 6
const TYPEFLAG_OFFSET = 156
const MAGIC_OFFSET = 257
const MAGIC_BYTES = 6
const VERSION_OFFSET = 263
const VERSION_BYTES = 2
const PREFIX_OFFSET = 345
const PREFIX_BYTES = 155
const MODE_OCTAL = '0000644'
const ZERO_OCTAL_7 = '0000000'
const ZERO_OCTAL_11 = '00000000000'
const REGULAR_FILE = 0x30
const OLD_REGULAR_FILE = 0x00
const PAX_EXTENDED_HEADER = 0x78
const PAX_HEADER_NAME = 'PaxHeader'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value)
  block.set(bytes.subarray(0, length), offset)
}

function writeOctal(block: Uint8Array, offset: number, digits: number, value: number): void {
  writeString(block, offset, digits, value.toString(8).padStart(digits, '0'))
}

function headerChecksum(block: Uint8Array): number {
  let sum = 0
  const checksumEnd = CHECKSUM_FIELD_OFFSET + CHECKSUM_FIELD_BYTES
  for (let at = 0; at < TAR_BLOCK_BYTES; at++) {
    sum += at >= CHECKSUM_FIELD_OFFSET && at < checksumEnd ? 0x20 : block[at]
  }
  return sum
}

function ustarBlock(name: string, prefix: string, size: number, typeflag: number): Uint8Array {
  const block = new Uint8Array(TAR_BLOCK_BYTES)
  writeString(block, NAME_OFFSET, NAME_BYTES, name)
  writeString(block, MODE_OFFSET, ID_FIELD_BYTES, MODE_OCTAL)
  writeString(block, OWNER_OFFSET, ID_FIELD_BYTES, ZERO_OCTAL_7)
  writeString(block, GROUP_OFFSET, ID_FIELD_BYTES, ZERO_OCTAL_7)
  writeOctal(block, SIZE_OFFSET, SIZE_FIELD_DIGITS, size)
  writeString(block, MTIME_OFFSET, MTIME_FIELD_BYTES, ZERO_OCTAL_11)
  block[TYPEFLAG_OFFSET] = typeflag
  writeString(block, MAGIC_OFFSET, MAGIC_BYTES, 'ustar')
  writeString(block, VERSION_OFFSET, VERSION_BYTES, '00')
  writeString(block, PREFIX_OFFSET, PREFIX_BYTES, prefix)
  const checksum = headerChecksum(block)
  writeString(block, CHECKSUM_FIELD_OFFSET, CHECKSUM_DIGITS, checksum.toString(8).padStart(CHECKSUM_DIGITS, '0'))
  block[CHECKSUM_FIELD_OFFSET + CHECKSUM_DIGITS] = 0
  block[CHECKSUM_FIELD_OFFSET + CHECKSUM_DIGITS + 1] = 0x20
  return block
}

function splitForUstar(name: string): { name: string; prefix: string } | null {
  if (encoder.encode(name).byteLength <= NAME_BYTES) return { name, prefix: '' }
  for (let slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) {
    const prefix = name.slice(0, slash)
    const rest = name.slice(slash + 1)
    if (encoder.encode(prefix).byteLength <= PREFIX_BYTES && encoder.encode(rest).byteLength <= NAME_BYTES) {
      return { name: rest, prefix }
    }
  }
  return null
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  const bodyBytes = encoder.encode(body).byteLength
  let digits = 1
  while (String(bodyBytes + digits).length !== digits) digits += 1
  return `${bodyBytes + digits}${body}`
}

export function tarPadding(size: number): Uint8Array {
  const remainder = size % TAR_BLOCK_BYTES
  return new Uint8Array(remainder === 0 ? 0 : TAR_BLOCK_BYTES - remainder)
}

export function tarEntryHeaders(name: string, size: number): Uint8Array[] {
  const split = splitForUstar(name)
  if (split !== null) return [ustarBlock(split.name, split.prefix, size, REGULAR_FILE)]
  const record = encoder.encode(paxRecord('path', name))
  return [
    ustarBlock(PAX_HEADER_NAME, '', record.byteLength, PAX_EXTENDED_HEADER),
    record,
    tarPadding(record.byteLength),
    ustarBlock(name.slice(-NAME_BYTES).replace(/^[^/]*\//, ''), '', size, REGULAR_FILE),
  ]
}

export function tarEnd(): Uint8Array {
  return new Uint8Array(TAR_BLOCK_BYTES * 2)
}

export function invalidArchive(message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Invalid snapshot archive: ${message}`, details)
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset
  while (end < offset + length && block[end] !== 0) end++
  try {
    return decoder.decode(block.subarray(offset, end))
  } catch {
    invalidArchive('an entry header holds a name that is not UTF-8')
  }
}

function readOctal(block: Uint8Array, offset: number, length: number, what: string): number {
  const text = readString(block, offset, length).trim()
  if (!/^[0-7]+$/.test(text)) invalidArchive(`an entry header holds an invalid ${what}`)
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) invalidArchive(`an entry header holds an invalid ${what}`)
  return value
}

export interface TarHeader {
  name: string
  size: number
  isPaxHeader: boolean
}

export function isZeroBlock(block: Uint8Array): boolean {
  for (let at = 0; at < block.length; at++) if (block[at] !== 0) return false
  return true
}

export function parseTarHeader(block: Uint8Array): TarHeader {
  if (readOctal(block, CHECKSUM_FIELD_OFFSET, CHECKSUM_FIELD_BYTES, 'checksum') !== headerChecksum(block)) {
    invalidArchive('an entry header fails its checksum')
  }
  const typeflag = block[TYPEFLAG_OFFSET]
  if (typeflag !== REGULAR_FILE && typeflag !== OLD_REGULAR_FILE && typeflag !== PAX_EXTENDED_HEADER) {
    invalidArchive(`an entry has type ${String.fromCharCode(typeflag)}, while an archive holds regular files alone`)
  }
  const name = readString(block, NAME_OFFSET, NAME_BYTES)
  const prefix = readString(block, PREFIX_OFFSET, PREFIX_BYTES)
  return {
    name: prefix.length > 0 ? `${prefix}/${name}` : name,
    size: readOctal(block, SIZE_OFFSET, SIZE_FIELD_BYTES, 'size'),
    isPaxHeader: typeflag === PAX_EXTENDED_HEADER,
  }
}

const SPACE = 0x20
const EQUALS = 0x3d
const NEWLINE = 0x0a

function decodeRecordText(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch {
    invalidArchive('a pax extended header is not UTF-8')
  }
}

export function parsePaxRecords(body: Uint8Array): Map<string, string> {
  const records = new Map<string, string>()
  let at = 0
  while (at < body.length) {
    const space = body.indexOf(SPACE, at)
    if (space < 0) invalidArchive('a pax extended header holds a malformed record')
    const length = Number.parseInt(decodeRecordText(body.subarray(at, space)), 10)
    if (!Number.isSafeInteger(length) || length <= space - at || at + length > body.length) {
      invalidArchive('a pax extended header holds a malformed record')
    }
    const record = body.subarray(space + 1, at + length)
    const equals = record.indexOf(EQUALS)
    if (equals < 0 || record[record.length - 1] !== NEWLINE) {
      invalidArchive('a pax extended header holds a record without a value')
    }
    records.set(decodeRecordText(record.subarray(0, equals)), decodeRecordText(record.subarray(equals + 1, -1)))
    at += length
  }
  return records
}
