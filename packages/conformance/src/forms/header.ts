import { FormError } from './decoded'
import { isJsonObject, type Json } from './json'

export interface HeaderForm {
  envelopeFormatVersion: number
  compression: 'none' | 'gzip'
  checksum: boolean
}

export function headerJson(header: HeaderForm): Json {
  return {
    envelopeFormatVersion: header.envelopeFormatVersion,
    compression: header.compression,
    checksum: header.checksum,
  }
}

export function headerFromJson(value: Json | undefined, what: string): HeaderForm {
  if (!isJsonObject(value)) throw new FormError(`${what} is not an object`)
  const { envelopeFormatVersion, compression, checksum } = value
  if (
    typeof envelopeFormatVersion !== 'number' ||
    !Number.isInteger(envelopeFormatVersion) ||
    envelopeFormatVersion < 0 ||
    envelopeFormatVersion > 0xff
  ) {
    throw new FormError(`${what}.envelopeFormatVersion is not a uint8`)
  }
  if (compression !== 'none' && compression !== 'gzip') throw new FormError(`${what}.compression is not none or gzip`)
  if (typeof checksum !== 'boolean') throw new FormError(`${what}.checksum is not a boolean`)
  return { envelopeFormatVersion, compression, checksum }
}
