import { growBufferTo } from '../shared-buffers/growable'
import { type SharedVectorStoreHandles, STORE_DOC_ID_BYTES } from './handles'

const encoder = new TextEncoder()

export function appendDocId(handles: SharedVectorStoreHandles, ordinal: number, docId: string): void {
  const bytes = encoder.encode(docId)
  const start = Atomics.load(handles.header, STORE_DOC_ID_BYTES)
  const end = start + bytes.length
  growBufferTo(handles.docIdBytes, end)
  growBufferTo(handles.docIdOffsets, (ordinal + 2) * 4)
  new Uint8Array(handles.docIdBytes).set(bytes, start)
  const offsets = new Uint32Array(handles.docIdOffsets)
  offsets[ordinal] = start
  offsets[ordinal + 1] = end
  Atomics.store(handles.header, STORE_DOC_ID_BYTES, end)
}

export function resetDocIds(handles: SharedVectorStoreHandles): void {
  new Uint32Array(handles.docIdOffsets).fill(0)
  Atomics.store(handles.header, STORE_DOC_ID_BYTES, 0)
}
