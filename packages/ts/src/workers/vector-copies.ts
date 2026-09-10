import type { PartitionManager } from '../partitioning/manager'
import { createSharedVectorSearcher } from '../vector/shared-field/searcher'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../vector/shared-field/types'
import { openSharedVectorField, type SharedVectorFieldView } from '../vector/shared-field/view'
import type { VectorSearcher } from '../vector/vector-index/shared'

interface HeldField {
  handle: string
  view: SharedVectorFieldView
}

/**
 * One worker holds an index's vector fields here, keyed by field name,
 * alongside the graph its searches answer from and every graph the threads
 * are still building.
 *
 * @internal
 */
export interface HeldVectorCopies {
  searchers: Map<string, VectorSearcher>
  fields: Map<string, HeldField>
  builds: Map<string, HeldField>
}

/**
 * Builds the empty record of the vector fields one worker holds for an index.
 *
 * @returns The record.
 *
 * @internal
 */
export function createHeldVectorCopies(): HeldVectorCopies {
  return { searchers: new Map(), fields: new Map(), builds: new Map() }
}

function fieldUnderHandle(held: HeldVectorCopies, fieldName: string, handle: string): HeldField | undefined {
  const searchable = held.fields.get(fieldName)
  if (searchable?.handle === handle) return searchable
  return held.builds.get(handle)
}

/**
 * Opens a field's handles on this worker, as a graph under construction or as
 * the graph searches answer from, and refreshes a field the worker already
 * holds under that handle.
 *
 * @param held The fields this worker holds for the index.
 * @param manager The worker's text copy of the index, which decides whether a
 * hit still names a document it holds.
 * @param fieldName The vector field the handles belong to.
 * @param handle The handle the main thread sent them under.
 * @param handles The field's shared structures.
 * @param threadSlot This thread's scratch and lock slot.
 *
 * @internal
 */
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

/**
 * Reports whether this worker holds a field in place, even where that field
 * holds no graph yet.
 *
 * @param held The fields this worker holds for the index.
 * @param fieldName The vector field to ask about.
 * @returns True where the worker reads that field in place.
 *
 * @internal
 */
export function holdsVectorField(held: HeldVectorCopies, fieldName: string): boolean {
  return held.fields.has(fieldName)
}

/**
 * Releases a field this worker holds under a handle, leaving a field it holds
 * under a later handle in place.
 *
 * @param held The fields this worker holds for the index.
 * @param fieldName The vector field to release.
 * @param handle The handle the field went out under.
 *
 * @internal
 */
export function dropHeldVectorCopy(held: HeldVectorCopies, fieldName: string, handle: string): void {
  held.builds.delete(handle)
  if (held.fields.get(fieldName)?.handle !== handle) return
  held.fields.delete(fieldName)
  held.searchers.delete(fieldName)
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    if (typeof setImmediate === 'function') setImmediate(resolve)
    else setTimeout(resolve, 0)
  })
}

/**
 * Places vectors in a graph this worker holds, yielding between vectors so
 * that the worker answers a request arriving meanwhile.
 *
 * @param held The fields this worker holds for the index.
 * @param fieldName The vector field the ordinals belong to.
 * @param handle The handle the field came in under.
 * @param ordinals The ordinals to place.
 * @returns What the worker saw while placing them, or null where it holds no
 * such field.
 *
 * @internal
 */
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

/**
 * Reads a document's vector from a field this worker holds in place.
 *
 * @param held The fields this worker holds for the index.
 * @param fieldName The vector field to read.
 * @param docId The document to read.
 * @returns The vector, or undefined where the field holds none for it.
 *
 * @internal
 */
export function heldVectorOf(held: HeldVectorCopies, fieldName: string, docId: string): Float32Array | undefined {
  return held.fields.get(fieldName)?.view.vectorOf(docId)
}
