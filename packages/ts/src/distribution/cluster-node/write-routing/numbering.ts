import type { MutationRecord } from '../../../persistence/durability/types'
import { encodeDocument } from '../../../serialization/document-encoding'
import type { AnyDocument } from '../../../types/schema'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import { replicationLogKey } from '../replication-logs'

interface OpenScope {
  log: () => ReplicationLog
  primaryTerm: number
  entries: ReplicationLogEntry[]
  admitted: Map<string, Uint8Array | null>
  deferCommit: boolean
}

export interface NumberedWrites {
  readonly entries: readonly ReplicationLogEntry[]
  admittedDocument(documentId: string): Uint8Array | null | undefined
  close(): void
}

export interface PrimaryNumbering {
  admit(indexName: string, partitionId: number, documentId: string, document: AnyDocument | null): void
  numberEntry(record: MutationRecord): ReplicationLogEntry | null
  defersCommit(record: MutationRecord): boolean
  open(
    indexName: string,
    partitionId: number,
    log: () => ReplicationLog,
    primaryTerm: number,
    deferCommit?: boolean,
  ): NumberedWrites
}

export function createPrimaryNumbering(): PrimaryNumbering {
  const scopes = new Map<string, OpenScope>()

  return {
    admit(indexName, partitionId, documentId, document) {
      const scope = scopes.get(replicationLogKey(indexName, partitionId))
      if (scope === undefined) return
      const encoded = document === null ? null : encodeDocument(document)
      scope.log().assertFits({ indexName, documentId, document: encoded })
      scope.admitted.set(documentId, encoded)
    },

    numberEntry(record) {
      const scope = scopes.get(replicationLogKey(record.indexName, record.partitionId))
      if (scope === undefined) return null
      const entry = scope.log().append({
        primaryTerm: scope.primaryTerm,
        operation: record.operation,
        partitionId: record.partitionId,
        indexName: record.indexName,
        documentId: record.documentId,
        document: record.document,
      })
      scope.entries.push(entry)
      return entry
    },

    defersCommit(record) {
      return scopes.get(replicationLogKey(record.indexName, record.partitionId))?.deferCommit === true
    },

    open(indexName, partitionId, log, primaryTerm, deferCommit = false) {
      const key = replicationLogKey(indexName, partitionId)
      const scope: OpenScope = { log, primaryTerm, entries: [], admitted: new Map(), deferCommit }
      scopes.set(key, scope)
      return {
        entries: scope.entries,
        admittedDocument: documentId => scope.admitted.get(documentId),
        close() {
          if (scopes.get(key) === scope) scopes.delete(key)
        },
      }
    },
  }
}
