import type { MutationRecord } from '../../../persistence/durability/types'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import { replicationLogKey } from '../replication-logs'

interface OpenScope {
  log: () => ReplicationLog
  primaryTerm: number
  entries: ReplicationLogEntry[]
}

export interface NumberedWrites {
  readonly entries: readonly ReplicationLogEntry[]
  close(): void
}

export interface PrimaryNumbering {
  numberEntry(record: MutationRecord): ReplicationLogEntry | null
  open(indexName: string, partitionId: number, log: () => ReplicationLog, primaryTerm: number): NumberedWrites
}

export function createPrimaryNumbering(): PrimaryNumbering {
  const scopes = new Map<string, OpenScope>()

  return {
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

    open(indexName, partitionId, log, primaryTerm) {
      const key = replicationLogKey(indexName, partitionId)
      const scope: OpenScope = { log, primaryTerm, entries: [] }
      scopes.set(key, scope)
      return {
        entries: scope.entries,
        close() {
          if (scopes.get(key) === scope) scopes.delete(key)
        },
      }
    },
  }
}
