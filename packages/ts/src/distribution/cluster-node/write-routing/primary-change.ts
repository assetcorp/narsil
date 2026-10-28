import { ErrorCodes, NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import { getClusterIndexConfig } from '../../cluster/index-metadata'
import { pause } from '../../cluster/rebalance/pause'
import type { AllocationTable } from '../../coordinator/types'
import { PRIMARY_CHANGE_POLL_INTERVAL_MS, PRIMARY_CHANGE_RETRY_WINDOW_MS } from '../constants'
import { resolvePartitionId } from './assignment'
import { storedCopyMatchesSent } from './sent-fields'
import type { WriteRoutingDeps } from './types'

interface RefusingPrimary {
  partitionCount: number
  partitionId: number
  primary: string | null
  primaryTerm: number
}

export interface RetriedFailure {
  docId: string
  error: unknown
}

export type SettleRetried = (failures: RetriedFailure[]) => Promise<ReadonlySet<string>>

interface RefusedItem<T> {
  item: T
  failure: BatchResult['failed'][number]
  refusing: RefusingPrimary
}

function refusedByPrimaryChange(error: unknown): boolean {
  return error instanceof NarsilError && error.code === ErrorCodes.PARTITION_NOT_PRIMARY
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof NarsilError && error.code === code
}

function primaryFor(table: AllocationTable | null, docId: string): RefusingPrimary | null {
  if (table === null || table.assignments.size === 0) return null
  const partitionId = resolvePartitionId(docId, table.assignments.size)
  const assignment = table.assignments.get(partitionId)
  return {
    partitionCount: table.assignments.size,
    partitionId,
    primary: assignment?.primary ?? null,
    primaryTerm: assignment?.primaryTerm ?? 0,
  }
}

function movedOn(table: AllocationTable, refusing: RefusingPrimary): boolean {
  if (table.assignments.size !== refusing.partitionCount) return true
  const assignment = table.assignments.get(refusing.partitionId)
  if (assignment === undefined || assignment.primary === null) return false
  return assignment.primary !== refusing.primary || assignment.primaryTerm > refusing.primaryTerm
}

async function liveTable(deps: WriteRoutingDeps, indexName: string): Promise<AllocationTable | null> {
  return deps.refreshAllocation !== undefined
    ? deps.refreshAllocation(indexName)
    : deps.coordinator.getAllocation(indexName)
}

async function awaitNewPrimary(
  deps: WriteRoutingDeps,
  indexName: string,
  refusing: RefusingPrimary[],
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    let table: AllocationTable | null | undefined
    try {
      table = await liveTable(deps, indexName)
    } catch (_) {
      table = undefined
    }
    if (table === null) return false
    if (table !== undefined && refusing.some(primary => movedOn(table, primary))) return true
    await pause(Math.max(0, Math.min(PRIMARY_CHANGE_POLL_INTERVAL_MS, deadline - Date.now())))
  }
  return false
}

export async function retryOnPrimaryChange<T>(
  deps: WriteRoutingDeps,
  indexName: string,
  docId: string,
  attempt: () => Promise<T>,
  settleRetried: SettleRetried,
  settledValue: () => T,
): Promise<T> {
  const deadline = Date.now() + PRIMARY_CHANGE_RETRY_WINDOW_MS
  let retried = false
  for (;;) {
    const refusing = primaryFor(await deps.coordinator.getAllocation(indexName), docId)
    try {
      return await attempt()
    } catch (error) {
      if (retried && (await settleRetried([{ docId, error }])).has(docId)) return settledValue()
      if (!refusedByPrimaryChange(error) || refusing === null) throw error
      if (!(await awaitNewPrimary(deps, indexName, [refusing], deadline))) throw error
      retried = true
    }
  }
}

export async function retryBatchOnPrimaryChange<T>(
  deps: WriteRoutingDeps,
  indexName: string,
  items: readonly T[],
  docIdOf: (item: T) => string,
  attempt: (items: T[]) => Promise<BatchResult>,
  settleRetried: SettleRetried,
): Promise<BatchResult> {
  const deadline = Date.now() + PRIMARY_CHANGE_RETRY_WINDOW_MS
  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  let pending = [...items]
  let retried = false
  while (pending.length > 0) {
    const table = await deps.coordinator.getAllocation(indexName)
    const result = await attempt(pending)
    succeeded.push(...result.succeeded)
    const settled = retried ? await settleRetried(result.failed) : new Set<string>()
    const pendingById = new Map(pending.map(item => [docIdOf(item), item]))
    const refused: RefusedItem<T>[] = []
    for (const failure of result.failed) {
      if (settled.has(failure.docId)) {
        succeeded.push(failure.docId)
        continue
      }
      const item = pendingById.get(failure.docId)
      const refusing = primaryFor(table, failure.docId)
      if (item === undefined || refusing === null || !refusedByPrimaryChange(failure.error)) {
        failed.push(failure)
        continue
      }
      refused.push({ item, failure, refusing })
    }
    if (refused.length === 0) break
    if (
      !(await awaitNewPrimary(
        deps,
        indexName,
        refused.map(entry => entry.refusing),
        deadline,
      ))
    ) {
      failed.push(...refused.map(entry => entry.failure))
      break
    }
    pending = refused.map(entry => entry.item)
    retried = true
  }
  return { succeeded, failed }
}

export const settleNothing: SettleRetried = async () => new Set()

export const settleAbsentRemovals: SettleRetried = async failures =>
  new Set(failures.filter(failure => hasCode(failure.error, ErrorCodes.DOC_NOT_FOUND)).map(failure => failure.docId))

async function derivedFieldsOf(deps: WriteRoutingDeps, indexName: string): Promise<Set<string>> {
  const schema = await deps.coordinator.getSchema(indexName)
  if (schema === null) return new Set()
  const config = await getClusterIndexConfig(deps.coordinator, indexName, schema)
  return new Set(Object.keys(config.embedding?.fields ?? {}))
}

export function settleEqualInserts(
  deps: WriteRoutingDeps,
  indexName: string,
  sentById: ReadonlyMap<string, AnyDocument>,
): SettleRetried {
  return async failures => {
    const existing = failures
      .filter(failure => hasCode(failure.error, ErrorCodes.DOC_ALREADY_EXISTS) && sentById.has(failure.docId))
      .map(failure => failure.docId)
    if (existing.length === 0 || deps.readPrimaryCopies === undefined) return new Set()
    let stored: Map<string, AnyDocument>
    let derivedFields: Set<string>
    try {
      stored = await deps.readPrimaryCopies(indexName, existing)
      derivedFields = await derivedFieldsOf(deps, indexName)
    } catch (_) {
      return new Set()
    }
    const settled = new Set<string>()
    for (const docId of existing) {
      const sent = sentById.get(docId)
      const copy = stored.get(docId)
      if (sent === undefined || copy === undefined) continue
      const derived = copy.id === docId && sent.id === undefined ? new Set([...derivedFields, 'id']) : derivedFields
      if (storedCopyMatchesSent(sent, copy, derived)) settled.add(docId)
    }
    return settled
  }
}
