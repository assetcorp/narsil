import { generateId } from '../../../core/id-generator'
import { providedDocId } from '../../../engine/mutations/insert-admission'
import type { AnyDocument, InsertOptions } from '../../../types/schema'
import type { WriteCondition } from '../../transport/types'
import { requireWritableIndex } from '../memory/write-block'
import { estimateDocumentBytes, withAdmittedWrite } from '../memory/write-pressure'
import { resolvePrimaryAssignment } from './assignment'
import { requireOpenWindow } from './forward-window'
import { forwardInsertToRemote, forwardRemoveToRemote, forwardUpdateToRemote } from './forwarding'
import { writeLocalOnly } from './numbered-write'
import { retryOnPrimaryChange, settleEqualInserts, settleNothing } from './primary-change'
import { applyPrimaryInsert, applyPrimaryRemove, applyPrimaryUpdate } from './primary-writes'
import type { WriteRoutingDeps } from './types'

export function routeInsert(
  indexName: string,
  document: AnyDocument,
  docId: string | undefined,
  deps: WriteRoutingDeps,
  options?: InsertOptions,
): Promise<string> {
  return withAdmittedWrite(
    deps.writePressure,
    indexName,
    () => estimateDocumentBytes(document),
    () => routeAdmittedInsert(indexName, document, docId, deps, options),
  )
}

async function routeAdmittedInsert(
  indexName: string,
  document: AnyDocument,
  docId: string | undefined,
  deps: WriteRoutingDeps,
  options?: InsertOptions,
): Promise<string> {
  const resolvedDocId = docId ?? providedDocId(document) ?? generateId()
  return retryOnPrimaryChange(
    deps,
    indexName,
    { docId: resolvedDocId, value: document },
    (_, deadline) => insertOnce(indexName, document, resolvedDocId, deps, deadline, options),
    settleEqualInserts(deps, indexName),
    () => resolvedDocId,
    true,
  )
}

async function insertOnce(
  indexName: string,
  document: AnyDocument,
  resolvedDocId: string,
  deps: WriteRoutingDeps,
  deadline: number,
  options?: InsertOptions,
): Promise<string> {
  const resolution = await resolvePrimaryAssignment(indexName, resolvedDocId, deps, false)

  if (resolution === null) {
    return writeLocalOnly(deps, indexName, () => deps.engine.insert(indexName, document, resolvedDocId, options))
  }

  requireWritableIndex(resolution.table, deps.memoryView)
  requireOpenWindow(deadline, indexName, resolvedDocId)
  const primaryNodeId = resolution.assignment.primary
  if (primaryNodeId === deps.nodeId) {
    return applyPrimaryInsert(
      indexName,
      document,
      resolvedDocId,
      resolution.partitionId,
      resolution.assignment,
      deps,
      options,
    )
  }

  return forwardInsertToRemote(
    indexName,
    document,
    resolvedDocId,
    primaryNodeId,
    deps,
    deadline,
    resolution.table.indexUuid,
  )
}

export function routeRemove(indexName: string, docId: string, deps: WriteRoutingDeps): Promise<void> {
  return retryOnPrimaryChange(
    deps,
    indexName,
    { docId, value: null },
    (condition, deadline) => removeOnce(indexName, docId, deps, condition, deadline),
    settleNothing,
    () => undefined,
  )
}

async function removeOnce(
  indexName: string,
  docId: string,
  deps: WriteRoutingDeps,
  condition: WriteCondition | undefined,
  deadline: number,
): Promise<void> {
  const resolution = await resolvePrimaryAssignment(indexName, docId, deps, false)

  if (resolution === null) {
    return writeLocalOnly(deps, indexName, () => deps.engine.remove(indexName, docId))
  }

  requireOpenWindow(deadline, indexName, docId)
  const primaryNodeId = resolution.assignment.primary
  if (primaryNodeId === deps.nodeId) {
    return applyPrimaryRemove(indexName, docId, resolution.partitionId, resolution.assignment, deps, condition)
  }

  return forwardRemoveToRemote(indexName, docId, primaryNodeId, deps, deadline, resolution.table.indexUuid, condition)
}

export function routeUpdate(
  indexName: string,
  docId: string,
  document: AnyDocument,
  deps: WriteRoutingDeps,
): Promise<void> {
  return withAdmittedWrite(
    deps.writePressure,
    indexName,
    () => estimateDocumentBytes(document),
    () =>
      retryOnPrimaryChange(
        deps,
        indexName,
        { docId, value: document },
        (condition, deadline) => routeAdmittedUpdate(indexName, docId, document, deps, condition, deadline),
        settleNothing,
        () => undefined,
      ),
  )
}

async function routeAdmittedUpdate(
  indexName: string,
  docId: string,
  document: AnyDocument,
  deps: WriteRoutingDeps,
  condition: WriteCondition | undefined,
  deadline: number,
): Promise<void> {
  const resolution = await resolvePrimaryAssignment(indexName, docId, deps, false)

  if (resolution === null) {
    return writeLocalOnly(deps, indexName, () => deps.engine.update(indexName, docId, document))
  }

  requireWritableIndex(resolution.table, deps.memoryView)
  requireOpenWindow(deadline, indexName, docId)
  const primaryNodeId = resolution.assignment.primary
  if (primaryNodeId === deps.nodeId) {
    return applyPrimaryUpdate(
      indexName,
      docId,
      document,
      resolution.partitionId,
      resolution.assignment,
      deps,
      condition,
    )
  }

  return forwardUpdateToRemote(
    indexName,
    document,
    docId,
    primaryNodeId,
    deps,
    deadline,
    resolution.table.indexUuid,
    condition,
  )
}
