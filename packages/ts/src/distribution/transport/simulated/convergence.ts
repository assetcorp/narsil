import { resolvePartitionId } from '../../cluster-node/write-routing'
import type { ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import { createListMessage, decodePayload } from '../../query/codec'
import { type ListResultPayload, QueryMessageTypes } from '../types'
import { MAX_REPORTED_KEYS, ORACLE_PAGE_LIMIT } from './constants'
import type { SimulatedNetwork } from './network'

export type AcknowledgedWriteState = 'present' | 'removed'

export interface WriteJournal {
  recordInsert(indexName: string, docId: string): void
  recordRemove(indexName: string, docId: string): void
  entriesFor(indexName: string): ReadonlyMap<string, AcknowledgedWriteState>
}

export interface ConvergenceOracle {
  assertConverged(indexName: string, journal?: WriteJournal): Promise<void>
}

export interface ConvergenceOracleDeps {
  network: SimulatedNetwork
  coordinator: ClusterCoordinator
}

const ORACLE_SOURCE_ID = 'convergence-oracle'

export function createWriteJournal(): WriteJournal {
  const entries = new Map<string, Map<string, AcknowledgedWriteState>>()

  function entriesOf(indexName: string): Map<string, AcknowledgedWriteState> {
    let indexEntries = entries.get(indexName)
    if (indexEntries === undefined) {
      indexEntries = new Map<string, AcknowledgedWriteState>()
      entries.set(indexName, indexEntries)
    }
    return indexEntries
  }

  return {
    recordInsert(indexName: string, docId: string): void {
      entriesOf(indexName).set(docId, 'present')
    },

    recordRemove(indexName: string, docId: string): void {
      entriesOf(indexName).set(docId, 'removed')
    },

    entriesFor(indexName: string): ReadonlyMap<string, AcknowledgedWriteState> {
      return entriesOf(indexName)
    },
  }
}

function canonicalise(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalise(entry)}`).join(',')}}`
  }
  return String(JSON.stringify(value))
}

function holdersOf(assignment: PartitionAssignment): string[] {
  const holders: string[] = []
  if (assignment.primary !== null) {
    holders.push(assignment.primary)
  }
  for (const replica of assignment.replicas) {
    if (!holders.includes(replica)) {
      holders.push(replica)
    }
  }
  return holders
}

function describeKeys(keys: string[]): string {
  const shown = keys.slice(0, MAX_REPORTED_KEYS).join(', ')
  if (keys.length <= MAX_REPORTED_KEYS) {
    return shown
  }
  return `${shown}, and ${keys.length - MAX_REPORTED_KEYS} more`
}

function diffDocuments(
  partitionId: number,
  reference: { nodeId: string; documents: Map<string, string> },
  other: { nodeId: string; documents: Map<string, string> },
  failures: string[],
): void {
  const missing: string[] = []
  const extra: string[] = []
  const differing: string[] = []

  for (const [docId, content] of reference.documents) {
    const otherContent = other.documents.get(docId)
    if (otherContent === undefined) {
      missing.push(docId)
    } else if (otherContent !== content) {
      differing.push(docId)
    }
  }
  for (const docId of other.documents.keys()) {
    if (!reference.documents.has(docId)) {
      extra.push(docId)
    }
  }

  if (missing.length > 0) {
    failures.push(
      `partition ${partitionId}: '${other.nodeId}' is missing ${describeKeys(missing)} held by '${reference.nodeId}'`,
    )
  }
  if (extra.length > 0) {
    failures.push(
      `partition ${partitionId}: '${other.nodeId}' holds ${describeKeys(extra)} absent from '${reference.nodeId}'`,
    )
  }
  if (differing.length > 0) {
    failures.push(
      `partition ${partitionId}: ${describeKeys(differing)} differ between '${reference.nodeId}' and '${other.nodeId}'`,
    )
  }
}

export function createConvergenceOracle(deps: ConvergenceOracleDeps): ConvergenceOracle {
  async function readPartition(nodeId: string, indexName: string, partitionId: number): Promise<Map<string, string>> {
    const message = createListMessage(
      {
        indexName,
        partitionIds: [partitionId],
        cursor: null,
        limit: ORACLE_PAGE_LIMIT,
        filters: null,
        sort: null,
        fields: null,
      },
      ORACLE_SOURCE_ID,
    )
    const response = await deps.network.directExchange(nodeId, message)
    if (response.type !== QueryMessageTypes.LIST_RESULT) {
      throw new Error(`node '${nodeId}' answered the partition read with '${response.type}'`)
    }
    const payload = decodePayload<ListResultPayload>(response.payload)
    if (payload.hasMore) {
      throw new Error(
        `partition ${partitionId} on node '${nodeId}' holds more than the ${ORACLE_PAGE_LIMIT} documents the oracle reads in one page`,
      )
    }
    const documents = new Map<string, string>()
    for (const entry of payload.entries) {
      documents.set(entry.docId, canonicalise(entry.document))
    }
    return documents
  }

  return {
    async assertConverged(indexName: string, journal?: WriteJournal): Promise<void> {
      const table = await deps.coordinator.getAllocation(indexName)
      if (table === null) {
        throw new Error(`Cluster has not converged: index '${indexName}' has no allocation`)
      }

      const failures: string[] = []
      const snapshots = new Map<string, Map<string, string>>()

      for (const [partitionId, assignment] of table.assignments) {
        if (assignment.primary === null) {
          failures.push(`partition ${partitionId} has no primary`)
          continue
        }
        if (assignment.state !== 'ACTIVE') {
          failures.push(`partition ${partitionId} is ${assignment.state}`)
        }
        for (const replica of assignment.replicas) {
          if (!assignment.inSyncSet.includes(replica)) {
            failures.push(`replica '${replica}' of partition ${partitionId} is outside the in-sync set`)
          }
        }

        const read: Array<{ nodeId: string; documents: Map<string, string> }> = []
        for (const holder of holdersOf(assignment)) {
          try {
            const documents = await readPartition(holder, indexName, partitionId)
            snapshots.set(`${holder}:${partitionId}`, documents)
            read.push({ nodeId: holder, documents })
          } catch (error) {
            const cause = error instanceof Error ? error.message : String(error)
            failures.push(`partition ${partitionId} on '${holder}' could not be read: ${cause}`)
          }
        }

        for (let i = 1; i < read.length; i++) {
          diffDocuments(partitionId, read[0], read[i], failures)
        }
      }

      if (journal !== undefined) {
        for (const [docId, state] of journal.entriesFor(indexName)) {
          const partitionId = resolvePartitionId(docId, table.assignments.size)
          const assignment = table.assignments.get(partitionId)
          if (assignment === undefined) {
            failures.push(`acknowledged write '${docId}' maps to partition ${partitionId}, which has no assignment`)
            continue
          }
          for (const holder of holdersOf(assignment)) {
            const documents = snapshots.get(`${holder}:${partitionId}`)
            if (documents === undefined) {
              continue
            }
            if (state === 'present' && !documents.has(docId)) {
              failures.push(`acknowledged write '${docId}' is missing from partition ${partitionId} on '${holder}'`)
            }
            if (state === 'removed' && documents.has(docId)) {
              failures.push(`acknowledged removal '${docId}' still appears in partition ${partitionId} on '${holder}'`)
            }
          }
        }
      }

      if (failures.length > 0) {
        throw new Error(`Cluster has not converged for index '${indexName}':\n  ${failures.join('\n  ')}`)
      }
    },
  }
}
