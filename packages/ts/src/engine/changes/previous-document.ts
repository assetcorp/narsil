import { encodeDocument, getNestedValue, setNestedValue } from '#platform/storage-host'
import type { AnyDocument } from '../../types/schema'
import type { EngineCore } from '../core'

export type PreviousDocumentReader = (docId: string) => Uint8Array | null

type ReadingCore = Pick<EngineCore, 'indexRegistry' | 'waqMap' | 'executor'>

function withVectorArrays(document: AnyDocument, vectorFieldPaths: ReadonlySet<string>): AnyDocument {
  for (const fieldPath of vectorFieldPaths) {
    const value = getNestedValue(document, fieldPath)
    if (value instanceof Float32Array) setNestedValue(document, fieldPath, Array.from(value))
  }
  return document
}

export function previousDocumentReader(core: ReadingCore, indexName: string): PreviousDocumentReader | null {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined || entry.changes?.previousDocument !== true) return null
  return docId => {
    const queued = core.waqMap.get(indexName)?.latest(docId)
    if (queued !== undefined) {
      return queued.action === 'remove' || queued.document === undefined ? null : encodeDocument(queued.document)
    }
    const stored = core.executor.getManager(indexName)?.get(docId)
    return stored === undefined ? null : encodeDocument(withVectorArrays(stored, entry.vectorFieldPaths))
  }
}
