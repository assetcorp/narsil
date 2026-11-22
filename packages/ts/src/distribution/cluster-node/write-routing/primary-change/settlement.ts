import { ErrorCodes, NarsilError } from '../../../../errors'
import type { AnyDocument } from '../../../../types/schema'
import { getClusterIndexConfig } from '../../../cluster/index-metadata'
import type { BatchWrite } from '../batch-write'
import { storedCopyMatchesSent } from '../sent-fields'
import type { WriteRoutingDeps } from '../types'

export interface RetriedFailure<V> {
  write: BatchWrite<V>
  error: unknown
}

export interface RetrySettlement {
  settled: ReadonlySet<BatchWrite<unknown>>
  unverified: ReadonlySet<BatchWrite<unknown>>
}

export type SettleRetried<V> = (
  failures: RetriedFailure<V>[],
  acknowledgedIds: ReadonlySet<string>,
) => Promise<RetrySettlement>

export const NOTHING_SETTLED: RetrySettlement = { settled: new Set(), unverified: new Set() }

export const settleNothing: SettleRetried<unknown> = async () => NOTHING_SETTLED

async function derivedFieldsOf(deps: WriteRoutingDeps, indexName: string): Promise<Set<string>> {
  const schema = await deps.coordinator.getSchema(indexName)
  if (schema === null) return new Set()
  const config = await getClusterIndexConfig(deps.coordinator, indexName, schema)
  return new Set(Object.keys(config.embedding?.fields ?? {}))
}

export function settleEqualInserts(deps: WriteRoutingDeps, indexName: string): SettleRetried<AnyDocument> {
  return async (failures, acknowledgedIds) => {
    const existing = failures
      .filter(
        ({ write, error }) =>
          error instanceof NarsilError &&
          error.code === ErrorCodes.DOC_ALREADY_EXISTS &&
          !acknowledgedIds.has(write.docId),
      )
      .map(failure => failure.write)
    if (existing.length === 0) return NOTHING_SETTLED
    if (deps.readPrimaryCopies === undefined) return { settled: new Set(), unverified: new Set(existing) }
    let stored: Map<string, AnyDocument>
    let derivedFields: Set<string>
    try {
      stored = await deps.readPrimaryCopies(indexName, [...new Set(existing.map(write => write.docId))])
      derivedFields = await derivedFieldsOf(deps, indexName)
    } catch (_) {
      return { settled: new Set(), unverified: new Set(existing) }
    }
    const settled = new Set<BatchWrite<unknown>>()
    const settledIds = new Set<string>()
    const unverified = new Set<BatchWrite<unknown>>()
    for (const write of existing) {
      const { docId, value: sent } = write
      if (settledIds.has(docId)) continue
      const copy = stored.get(docId)
      if (copy === undefined) {
        unverified.add(write)
        continue
      }
      const derived = copy.id === docId && sent.id === undefined ? new Set([...derivedFields, 'id']) : derivedFields
      if (!storedCopyMatchesSent(sent, copy, derived)) continue
      settled.add(write)
      settledIds.add(docId)
    }
    return { settled, unverified }
  }
}
