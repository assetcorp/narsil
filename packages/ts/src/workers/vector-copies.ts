import type { PartitionManager } from '../partitioning/manager'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../vector/shared-field/types'
import type { SharedVectorFieldView } from '../vector/shared-field/view'
import type { VectorSearcher } from '../vector/vector-index/shared'
import type { HeldAdmission } from '../vector/vector-store/admission'
import type { CopyPublication } from './copy-publication'
import { requireLoadedVectorCode } from './vector-code'

interface HeldField {
  handle: string
  view: SharedVectorFieldView
  publication?: HeldAdmission
  readers?: number
  retired?: boolean
}

export interface HeldVectorCopies {
  searchers: Map<string, VectorSearcher>
  fields: Map<string, HeldField>
  builds: Map<string, HeldField>
  published: boolean
}

export function createHeldVectorCopies(): HeldVectorCopies {
  return { searchers: new Map(), fields: new Map(), builds: new Map(), published: false }
}

function retireField(field: HeldField): void {
  field.publication?.release()
  field.retired = true
  if ((field.readers ?? 0) === 0) field.view.close()
}

export function prepareVectorPublication(
  held: HeldVectorCopies,
  manager: PartitionManager,
  publication: CopyPublication,
  threadSlot: number,
): { commit(): void; release(): void } {
  const fields = new Map<string, HeldField>()
  const searchers = new Map<string, VectorSearcher>()
  try {
    for (const { fieldName, vector } of publication.fields) {
      const code = requireLoadedVectorCode()
      const previous = held.fields.get(fieldName)
      const field =
        previous?.handle === vector.handle
          ? previous
          : { handle: vector.handle, view: code.openSharedVectorField(vector.handles, threadSlot) }
      fields.set(fieldName, { handle: field.handle, view: field.view })
      if (field === previous) field.view.adopt(vector.handles)
      const pin = code.holdAdmission(field.view.store, vector.sequence)
      fields.set(fieldName, { ...field, publication: pin })
      searchers.set(
        fieldName,
        code.createSharedVectorSearcher({ fieldName, view: field.view, holdsDocument: id => manager.has(id) }),
      )
    }
  } catch (error) {
    for (const [fieldName, field] of fields) {
      field.publication?.release()
      if (held.fields.get(fieldName)?.view !== field.view) field.view.close()
    }
    throw error
  }
  let pending = true
  return {
    commit() {
      if (!pending) return
      pending = false
      for (const [fieldName, previous] of held.fields) {
        const next = fields.get(fieldName)
        if (next?.view === previous.view) {
          previous.publication?.release()
          previous.publication = next.publication
          fields.set(fieldName, previous)
        } else retireField(previous)
      }
      held.fields.clear()
      held.searchers.clear()
      for (const [fieldName, field] of fields) held.fields.set(fieldName, field)
      for (const [fieldName, searcher] of searchers) held.searchers.set(fieldName, searcher)
      held.published = true
    },
    release() {
      if (!pending) return
      pending = false
      for (const [fieldName, field] of fields) {
        field.publication?.release()
        if (held.fields.get(fieldName)?.view !== field.view) field.view.close()
      }
    },
  }
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
  storeHandle?: string,
): void {
  const { createSharedVectorSearcher, openSharedVectorField } = requireLoadedVectorCode()
  if (held.published) {
    const field = held.fields.get(fieldName)
    if (handles.searchable && field !== undefined && field.handle === storeHandle) field.view.adopt(handles)
    const build = held.builds.get(handle)
    if (build === undefined) held.builds.set(handle, { handle, view: openSharedVectorField(handles, threadSlot) })
    else build.view.adopt(handles)
    return
  }
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
  const field = held.fields.get(fieldName)
  return (
    field !== undefined &&
    (field.publication !== undefined || (field.view.readsEveryVector && !field.view.graphRetired))
  )
}

export function dropHeldVectorCopy(held: HeldVectorCopies, fieldName: string, handle: string): void {
  held.builds.get(handle)?.view.close()
  held.builds.delete(handle)
  const field = held.fields.get(fieldName)
  if (field?.handle !== handle) return
  retireField(field)
  held.fields.delete(fieldName)
  held.searchers.delete(fieldName)
}

export function closeHeldVectorCopies(held: HeldVectorCopies): void {
  for (const build of held.builds.values()) build.view.close()
  for (const field of held.fields.values()) retireField(field)
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
  const pin = pinHeldVectorField(held, fieldName)
  if (pin === undefined) return undefined
  try {
    return pin.vectorOf(docId)
  } finally {
    pin.release()
  }
}

export interface HeldFieldPin extends HeldAdmission {
  vectorOf(docId: string): Float32Array | undefined
}

export function pinHeldVectorField(held: HeldVectorCopies, fieldName: string): HeldFieldPin | undefined {
  const field = held.fields.get(fieldName)
  if (field === undefined) return undefined
  const { view } = field
  const { store } = view
  const pin = requireLoadedVectorCode().holdAdmission(store, field.publication?.admission.pin)
  field.readers = (field.readers ?? 0) + 1
  let released = false
  const slots = store.slots
  let priorOrdinals: Map<string, number> | undefined
  return {
    ...pin,
    release() {
      if (released) return
      released = true
      pin.release()
      field.readers = (field.readers ?? 1) - 1
      if (field.retired && field.readers === 0) field.view.close()
    },
    vectorOf(docId) {
      const current = view.ordinalOf(docId)
      if (current !== undefined && pin.admission.docIdOf(current) === docId) return store.vectorAt(current)
      if (priorOrdinals === undefined) {
        priorOrdinals = new Map()
        for (let ordinal = 0; ordinal < slots; ordinal++) {
          const heldId = pin.admission.docIdOf(ordinal)
          if (heldId !== undefined) priorOrdinals.set(heldId, ordinal)
        }
      }
      const prior = priorOrdinals.get(docId)
      return prior === undefined ? undefined : store.vectorAt(prior)
    },
  }
}
