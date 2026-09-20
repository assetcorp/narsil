import type { PartitionManager } from '../partitioning/manager'
import { createSharedVectorSearcher } from '../vector/shared-field/searcher'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../vector/shared-field/types'
import { openSharedVectorField, type SharedVectorFieldView } from '../vector/shared-field/view'
import type { VectorSearcher } from '../vector/vector-index/shared'

interface HeldField {
  handle: string
  view: SharedVectorFieldView
}

export interface HeldVectorCopies {
  searchers: Map<string, VectorSearcher>
  fields: Map<string, HeldField>
  builds: Map<string, HeldField>
}

export function createHeldVectorCopies(): HeldVectorCopies {
  return { searchers: new Map(), fields: new Map(), builds: new Map() }
}

function fieldUnderHandle(held: HeldVectorCopies, fieldName: string, handle: string): HeldField | undefined {
  const searchable = held.fields.get(fieldName)
  if (searchable?.handle === handle) return searchable
  return held.builds.get(handle)
}

export function loadHeldVectorCopy(
  held: HeldVectorCopies,
  manager: PartitionManager,
  fieldName: string,
  handle: string,
  handles: SharedVectorFieldHandles,
  threadSlot: number,
): void {
  const existing = fieldUnderHandle(held, fieldName, handle)
  const view = existing?.view ?? openSharedVectorField(handles, threadSlot)
  if (existing !== undefined) view.adopt(handles)

  if (!handles.searchable) {
    held.builds.set(handle, { handle, view })
    return
  }
  held.builds.delete(handle)
  held.fields.set(fieldName, { handle, view })
  if (handles.graph === null) {
    held.searchers.delete(fieldName)
    return
  }
  held.searchers.set(
    fieldName,
    createSharedVectorSearcher({ fieldName, view, holdsDocument: docId => manager.has(docId) }),
  )
}

export function holdsVectorField(held: HeldVectorCopies, fieldName: string): boolean {
  return held.fields.get(fieldName)?.view.readsEveryVector === true
}

export function dropHeldVectorCopy(held: HeldVectorCopies, fieldName: string, handle: string): void {
  held.builds.get(handle)?.view.close()
  held.builds.delete(handle)
  const field = held.fields.get(fieldName)
  if (field?.handle !== handle) return
  field.view.close()
  held.fields.delete(fieldName)
  held.searchers.delete(fieldName)
}

export function closeHeldVectorCopies(held: HeldVectorCopies): void {
  for (const build of held.builds.values()) build.view.close()
  for (const field of held.fields.values()) field.view.close()
  held.builds.clear()
  held.fields.clear()
  held.searchers.clear()
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    if (typeof setImmediate === 'function') setImmediate(resolve)
    else setTimeout(resolve, 0)
  })
}

export async function insertIntoHeldGraph(
  held: HeldVectorCopies,
  fieldName: string,
  handle: string,
  ordinals: Int32Array,
): Promise<GraphInsertOutcome | null> {
  const field = fieldUnderHandle(held, fieldName, handle)
  if (field === undefined) return null
  for (const ordinal of ordinals) {
    field.view.insertOrdinal(ordinal)
    await yieldToEventLoop()
  }
  return field.view.takeOutcome()
}

export function heldVectorOf(held: HeldVectorCopies, fieldName: string, docId: string): Float32Array | undefined {
  return held.fields.get(fieldName)?.view.vectorOf(docId)
}
