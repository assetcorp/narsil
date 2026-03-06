import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import {
  decodeFlags,
  encodeFlags,
  HEADER_SIZE,
  type NrslFlags,
  type NrslHeader,
  readHeader,
  writeHeader,
} from '../../serialization/header'

function makeHeader(overrides: Partial<NrslHeader> = {}): NrslHeader {
  return {
    magic: 'NRSL',
    envelopeFormatVersion: 1,
    engineVersionMajor: 0,
    engineVersionMinor: 1,
    engineVersionPatch: 0,
    payloadLength: 1024,
    flags: {
      compressionEnabled: false,
      compressionAlgorithm: 'none',
      checksumPresent: false,
      encryptionEnabled: false,
    },
    checksum: 0,
    reserved: new Uint8Array(14),
    ...overrides,
  }
}

describe('encodeFlags / decodeFlags', () => {
  it('roundtrips default flags (all disabled)', () => {
    const flags: NrslFlags = {
      compressionEnabled: false,
      compressionAlgorithm: 'none',
      checksumPresent: false,
      encryptionEnabled: false,
    }
    const encoded = encodeFlags(flags)
    expect(encoded).toBe(0)
    const decoded = decodeFlags(encoded)
    expect(decoded).toEqual(flags)
  })

  it('roundtrips gzip compression enabled', () => {
    const flags: NrslFlags = {
      compressionEnabled: true,
      compressionAlgorithm: 'gzip',
      checksumPresent: false,
      encryptionEnabled: false,
    }
    const encoded = encodeFlags(flags)
    expect(encoded & 1).toBe(1)
    const decoded = decodeFlags(encoded)
    expect(decoded).toEqual(flags)
  })

  it('roundtrips lz4 compression', () => {
    const flags: NrslFlags = {
      compressionEnabled: true,
      compressionAlgorithm: 'lz4',
      checksumPresent: false,
      encryptionEnabled: false,
    }
    const decoded = decodeFlags(encodeFlags(flags))
    expect(decoded).toEqual(flags)
  })

  it('roundtrips zstd compression', () => {
    const flags: NrslFlags = {
      compressionEnabled: true,
      compressionAlgorithm: 'zstd',
      checksumPresent: false,
      encryptionEnabled: false,
    }
    const decoded = decodeFlags(encodeFlags(flags))
    expect(decoded).toEqual(flags)
  })

  it('roundtrips checksum present', () => {
    const flags: NrslFlags = {
      compressionEnabled: false,
      compressionAlgorithm: 'none',
      checksumPresent: true,
      encryptionEnabled: false,
    }
    const decoded = decodeFlags(encodeFlags(flags))
    expect(decoded).toEqual(flags)
  })

  it('roundtrips encryption enabled', () => {
    const flags: NrslFlags = {
      compressionEnabled: false,
      compressionAlgorithm: 'none',
      checksumPresent: false,
      encryptionEnabled: true,
    }
    const decoded = decodeFlags(encodeFlags(flags))
    expect(decoded).toEqual(flags)
  })

  it('roundtrips all flags enabled (gzip + checksum + encryption)', () => {
    const flags: NrslFlags = {
      compressionEnabled: true,
      compressionAlgorithm: 'gzip',
      checksumPresent: true,
      encryptionEnabled: true,
    }
    const decoded = decodeFlags(encodeFlags(flags))
    expect(decoded).toEqual(flags)
  })
})

describe('writeHeader / readHeader', () => {
  it('produces exactly 32 bytes', () => {
    const bytes = writeHeader(makeHeader())
    expect(bytes.length).toBe(HEADER_SIZE)
    expect(bytes.length).toBe(32)
  })

  it('writes NRSL magic bytes at offset 0', () => {
    const bytes = writeHeader(makeHeader())
    expect(bytes[0]).toBe(0x4e)
    expect(bytes[1]).toBe(0x52)
    expect(bytes[2]).toBe(0x53)
    expect(bytes[3]).toBe(0x4c)
  })

  it('roundtrips a basic header', () => {
    const original = makeHeader()
    const bytes = writeHeader(original)
    const restored = readHeader(bytes)

    expect(restored.magic).toBe('NRSL')
    expect(restored.envelopeFormatVersion).toBe(original.envelopeFormatVersion)
    expect(restored.engineVersionMajor).toBe(original.engineVersionMajor)
    expect(restored.engineVersionMinor).toBe(original.engineVersionMinor)
    expect(restored.engineVersionPatch).toBe(original.engineVersionPatch)
    expect(restored.payloadLength).toBe(original.payloadLength)
    expect(restored.flags).toEqual(original.flags)
    expect(restored.checksum).toBe(original.checksum)
  })

  it('roundtrips header with compression and checksum', () => {
    const original = makeHeader({
      flags: {
        compressionEnabled: true,
        compressionAlgorithm: 'gzip',
        checksumPresent: true,
        encryptionEnabled: false,
      },
      checksum: 0xcbf43926,
    })
    const restored = readHeader(writeHeader(original))

    expect(restored.flags.compressionEnabled).toBe(true)
    expect(restored.flags.compressionAlgorithm).toBe('gzip')
    expect(restored.flags.checksumPresent).toBe(true)
    expect(restored.checksum).toBe(0xcbf43926)
  })

  it('roundtrips engine version 12.34.56', () => {
    const original = makeHeader({
      engineVersionMajor: 12,
      engineVersionMinor: 34,
      engineVersionPatch: 56,
    })
    const restored = readHeader(writeHeader(original))
    expect(restored.engineVersionMajor).toBe(12)
    expect(restored.engineVersionMinor).toBe(34)
    expect(restored.engineVersionPatch).toBe(56)
  })

  it('roundtrips large payload length', () => {
    const original = makeHeader({ payloadLength: 0xfedcba98 })
    const restored = readHeader(writeHeader(original))
    expect(restored.payloadLength).toBe(0xfedcba98)
  })

  it('writes reserved bytes as zeros', () => {
    const bytes = writeHeader(makeHeader())
    for (let i = 18; i < 32; i++) {
      expect(bytes[i]).toBe(0x00)
    }
  })

  it('throws ENVELOPE_INVALID_MAGIC for data shorter than 32 bytes', () => {
    const tooShort = new Uint8Array(16)
    expect(() => readHeader(tooShort)).toThrow(NarsilError)
    try {
      readHeader(tooShort)
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.ENVELOPE_INVALID_MAGIC)
    }
  })

  it('throws ENVELOPE_INVALID_MAGIC for wrong magic bytes', () => {
    const bytes = writeHeader(makeHeader())
    bytes[0] = 0x00
    expect(() => readHeader(bytes)).toThrow(NarsilError)
    try {
      readHeader(bytes)
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.ENVELOPE_INVALID_MAGIC)
    }
  })

  it('reads header from a larger buffer (header + payload data)', () => {
    const headerBytes = writeHeader(makeHeader({ payloadLength: 8 }))
    const full = new Uint8Array(40)
    full.set(headerBytes, 0)
    full.set(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 32)

    const restored = readHeader(full)
    expect(restored.payloadLength).toBe(8)
  })
})
