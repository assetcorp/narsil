import { ErrorCodes, NarsilError } from '#platform/storage-host'
import { crc32 } from '../checksum'
import type { DurableDirectory } from '../durable-filesystem'
import {
  checkSegmentHeader,
  decodeWalEntry,
  FRAME_CRC_SIZE,
  MAX_WAL_RECORD_BYTES,
  RECORD_LENGTH_SIZE,
  SEGMENT_HEADER_SIZE,
} from '../wal-framing'
import { LOG_READ_CHUNK_BYTES } from './constants'

export interface LogFrame {
  seqNo: number
  payload: Uint8Array
  frameBytes: number
}

export class SegmentFileMissing extends Error {}

function corrupt(key: string, message: string, details: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_WAL_CORRUPT, `${message} in "${key}"`, { key, ...details })
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

export class FrameCursor {
  private buffer: Uint8Array = new Uint8Array(0)
  private bufferStart = 0
  private whole: Uint8Array | null = null

  constructor(
    private readonly directory: DurableDirectory,
    private readonly key: string,
    readonly limit: number,
  ) {}

  private async load(offset: number, length: number): Promise<void> {
    const readRange = this.directory.readRange
    if (readRange === undefined) {
      if (this.whole === null) {
        const bytes = await this.directory.read(this.key)
        if (bytes === null) throw new SegmentFileMissing(this.key)
        this.whole = bytes
      }
      this.buffer = this.whole
      this.bufferStart = 0
      return
    }
    const wanted = Math.min(Math.max(length, LOG_READ_CHUNK_BYTES), this.limit - offset)
    try {
      this.buffer = await readRange.call(this.directory, this.key, offset, wanted)
    } catch (error) {
      if (isMissingFile(error)) throw new SegmentFileMissing(this.key)
      throw error
    }
    this.bufferStart = offset
  }

  async bytesAt(offset: number, length: number): Promise<Uint8Array> {
    const end = offset + length
    if (end > this.limit) corrupt(this.key, 'A log frame overruns the readable region', { offset, length })
    if (offset < this.bufferStart || end > this.bufferStart + this.buffer.byteLength) await this.load(offset, length)
    return this.buffer.subarray(offset - this.bufferStart, end - this.bufferStart)
  }

  async checkHeader(): Promise<void> {
    if (this.limit < SEGMENT_HEADER_SIZE) corrupt(this.key, 'A log segment is shorter than its header', {})
    const header = checkSegmentHeader(await this.bytesAt(0, SEGMENT_HEADER_SIZE))
    if (!header.ok) corrupt(this.key, `A log segment header is invalid: ${header.reason}`, {})
  }

  async frameLengthAt(offset: number): Promise<number> {
    const lengthBytes = await this.bytesAt(offset, RECORD_LENGTH_SIZE)
    const recordLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, RECORD_LENGTH_SIZE).getUint32(
      0,
      false,
    )
    if (recordLength === 0 || recordLength > MAX_WAL_RECORD_BYTES) {
      corrupt(this.key, 'A log record length is zero or above the largest record', { offset, recordLength })
    }
    return RECORD_LENGTH_SIZE + recordLength + FRAME_CRC_SIZE
  }

  async frameAt(offset: number, frameBytes: number): Promise<LogFrame> {
    const recordLength = frameBytes - RECORD_LENGTH_SIZE - FRAME_CRC_SIZE
    const body = await this.bytesAt(offset + RECORD_LENGTH_SIZE, recordLength + FRAME_CRC_SIZE)
    const payload = body.subarray(0, recordLength)
    const storedCrc = new DataView(body.buffer, body.byteOffset + recordLength, FRAME_CRC_SIZE).getUint32(0, false)
    if (crc32(payload) !== storedCrc) corrupt(this.key, 'A log record fails its frame checksum', { offset })
    let seqNo: number
    try {
      seqNo = decodeWalEntry(payload).seqNo
    } catch (error) {
      corrupt(this.key, 'A log record fails to decode', {
        offset,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    return { seqNo, payload: payload.slice(), frameBytes }
  }
}
