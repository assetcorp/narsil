import { type FileRef, manifestFileRefs, type SegmentManifest } from '../durability/segment/manifest'
import { ARCHIVE_FILE_CHUNK_BYTES } from './constants'
import { ARCHIVE_CONFIG_ENTRY, ARCHIVE_MANIFEST_ENTRY } from './read'
import { tarEnd, tarEntryHeaders, tarPadding } from './tar'

export interface ArchiveSource {
  config: Uint8Array
  manifestBytes: Uint8Array
  manifest: SegmentManifest
  sourceIndexName: string
  readRange(ref: FileRef, offset: number, length: number): Promise<Uint8Array>
  release(): void
}

function entryChunks(name: string, bytes: Uint8Array): Uint8Array[] {
  return [...tarEntryHeaders(name, bytes.byteLength), bytes, tarPadding(bytes.byteLength)].filter(
    chunk => chunk.byteLength > 0,
  )
}

async function* fileEntryChunks(source: ArchiveSource, name: string, ref: FileRef): AsyncGenerator<Uint8Array> {
  yield* tarEntryHeaders(name, ref.bytes).filter(chunk => chunk.byteLength > 0)
  for (let offset = 0; offset < ref.bytes; offset += ARCHIVE_FILE_CHUNK_BYTES) {
    yield await source.readRange(ref, offset, Math.min(ARCHIVE_FILE_CHUNK_BYTES, ref.bytes - offset))
  }
  const padding = tarPadding(ref.bytes)
  if (padding.byteLength > 0) yield padding
}

async function* archiveChunks(source: ArchiveSource): AsyncGenerator<Uint8Array> {
  yield* entryChunks(ARCHIVE_CONFIG_ENTRY, source.config)
  yield* entryChunks(ARCHIVE_MANIFEST_ENTRY, source.manifestBytes)
  const prefix = `${source.sourceIndexName}/`
  for (const ref of manifestFileRefs(source.manifest)) {
    yield* fileEntryChunks(source, ref.key.slice(prefix.length), ref)
  }
  yield tarEnd()
}

export function archiveStream(source: ArchiveSource): ReadableStream<Uint8Array> {
  const chunks = archiveChunks(source)
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    source.release()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await chunks.next()
        if (step.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(step.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel() {
      release()
      await chunks.return(undefined)
    },
  })
}
