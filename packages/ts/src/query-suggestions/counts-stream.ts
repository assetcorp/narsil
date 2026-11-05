import { compareCodePoints } from '../core/ordering'
import { COUNTS_STREAM_CHUNK_BYTES, MAX_COUNTS_STREAM_KEY_BYTES, MAX_HISTORY_FILE_BYTES } from './constants'
import { type HistoryFiles, historyFileOf, historyFolderOf, listHistoryFolder } from './history-files'

const KEY_LENGTH_BYTES = 2
const FILE_LENGTH_BYTES = 4

export interface StreamedHistoryFile {
  key: string
  bytes: Uint8Array
}

function frameHeader(relativeKey: Uint8Array, fileBytes: number): Uint8Array {
  const header = new Uint8Array(KEY_LENGTH_BYTES + relativeKey.byteLength + FILE_LENGTH_BYTES)
  const view = new DataView(header.buffer)
  view.setUint16(0, relativeKey.byteLength)
  header.set(relativeKey, KEY_LENGTH_BYTES)
  view.setUint32(KEY_LENGTH_BYTES + relativeKey.byteLength, fileBytes)
  return header
}

export async function* historyStreamChunks(files: HistoryFiles, indexName: string): AsyncGenerator<Uint8Array> {
  const folder = historyFolderOf(indexName)
  const keys = (await listHistoryFolder(files, indexName))
    .filter(key => historyFileOf(indexName, key) !== null)
    .sort(compareCodePoints)
  let sent = false
  for (const key of keys) {
    const bytes = await files.read(key)
    if (bytes === null || bytes === 'too-long') continue
    sent = true
    yield frameHeader(new TextEncoder().encode(key.slice(folder.length)), bytes.byteLength)
    for (let at = 0; at < bytes.byteLength; at += COUNTS_STREAM_CHUNK_BYTES) {
      yield bytes.subarray(at, Math.min(at + COUNTS_STREAM_CHUNK_BYTES, bytes.byteLength))
    }
  }
  if (!sent) yield new Uint8Array(0)
}

type ReaderPart = 'key-length' | 'key' | 'file-length' | 'file'

export class HistoryStreamReader {
  private readonly indexName: string
  private readonly folder: string
  private part: ReaderPart = 'key-length'
  private need = KEY_LENGTH_BYTES
  private buffer = new Uint8Array(KEY_LENGTH_BYTES)
  private filled = 0
  private key = ''
  private refusedFor: string | null = null

  constructor(indexName: string) {
    this.indexName = indexName
    this.folder = historyFolderOf(indexName)
  }

  get refusal(): string | null {
    return this.refusedFor
  }

  get endsCleanly(): boolean {
    return this.refusedFor === null && this.part === 'key-length' && this.filled === 0
  }

  push(chunk: Uint8Array): StreamedHistoryFile[] {
    const complete: StreamedHistoryFile[] = []
    let at = 0
    while (at < chunk.byteLength && this.refusedFor === null) {
      const taken = Math.min(this.need - this.filled, chunk.byteLength - at)
      this.buffer.set(chunk.subarray(at, at + taken), this.filled)
      this.filled += taken
      at += taken
      if (this.filled === this.need) this.advance(complete)
    }
    return complete
  }

  private expect(part: ReaderPart, bytes: number): void {
    this.part = part
    this.need = bytes
    this.filled = 0
    this.buffer = new Uint8Array(bytes)
  }

  private refuse(reason: string): void {
    this.refusedFor = reason
    this.buffer = new Uint8Array(0)
  }

  private advance(complete: StreamedHistoryFile[]): void {
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
    if (this.part === 'key-length') {
      const length = view.getUint16(0)
      if (length === 0 || length > MAX_COUNTS_STREAM_KEY_BYTES) {
        this.refuse(`a key length of ${length} bytes`)
        return
      }
      this.expect('key', length)
      return
    }
    if (this.part === 'key') {
      let relative: string
      try {
        relative = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer)
      } catch {
        this.refuse('a key that is not UTF-8')
        return
      }
      const key = `${this.folder}${relative}`
      if (historyFileOf(this.indexName, key) === null) {
        this.refuse('a key that names no history file')
        return
      }
      this.key = key
      this.expect('file-length', FILE_LENGTH_BYTES)
      return
    }
    if (this.part === 'file-length') {
      const length = view.getUint32(0)
      if (length > MAX_HISTORY_FILE_BYTES) {
        this.refuse(`a file of ${length} bytes`)
        return
      }
      if (length === 0) {
        complete.push({ key: this.key, bytes: new Uint8Array(0) })
        this.expect('key-length', KEY_LENGTH_BYTES)
        return
      }
      this.expect('file', length)
      return
    }
    complete.push({ key: this.key, bytes: this.buffer })
    this.expect('key-length', KEY_LENGTH_BYTES)
  }
}
