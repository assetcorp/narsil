import type { SerializedSurfaceForms } from '../../../types/internal'
import type { AnyDocument } from '../../../types/schema'
import type { NativeFrozenStrings } from '../../../vector/native/types/frozen-segments'
import { documentValueBytes } from '../../document-store'
import {
  createSurfaceRegistry,
  type SurfaceFormCandidate,
  type SurfaceRegistry,
  type SurfaceRegistryReader,
} from '../../surface-registry'
import {
  type PartialWordAnalysis,
  visitDocumentSpellings,
  visitDocumentSurfaceSpellings,
} from '../partial-words/spellings'
import { REMOVED_SURFACE_ENTRY_BYTES } from './constants'
import type { RemovedSpellings } from './removed-spellings'
import { createSurfaceRemovalState } from './surface-state'

export type { RemovedSpellings } from './removed-spellings'

export type TextAnalysis = Omit<PartialWordAnalysis, 'fields'>

export interface SurfaceTableReader {
  candidatesForPrefix(prefix: string): SurfaceFormCandidate[]
  heldBytes(): number
}

export interface FrozenSurfaceDocuments {
  readonly count: number
  readonly textFields: readonly string[]
  documentAt(ordinal: number): AnyDocument
}

export interface FrozenSurfaceSlot {
  readonly reader: SurfaceRegistryReader
  heldBytes(): number
  tableStaysOnDisk(): boolean
  holdsAny(): boolean
  tokenOf(surface: string): string | undefined
  subtractSpellings(ordinal: number, spellings: RemovedSpellings): void
  prepareRemoval(ordinal: number, spellings: RemovedSpellings): () => void
  coreRegions(): { table: NativeFrozenStrings; removed: Uint32Array }
  prepareCoreRemoval(
    ordinal: number,
    spellings: RemovedSpellings,
  ): {
    table: NativeFrozenStrings
    removed: Uint32Array
    publish(): void
  }
  addKeptForms(target: SurfaceRegistry, mergedOrdinals: Int32Array, analysis: TextAnalysis | null): void
}

function applyDocumentSurfaces(
  target: SurfaceRegistry,
  document: AnyDocument,
  analysis: PartialWordAnalysis,
  direction: 1 | -1,
): void {
  if (direction === -1) {
    visitDocumentSurfaceSpellings(document, analysis, spelling => target.subtract(spelling, 1))
    return
  }
  visitDocumentSpellings(document, analysis, (token, spelling) => {
    if (spelling !== token) target.add(spelling, token, 1)
  })
}

function addForms(target: SurfaceRegistry, forms: SerializedSurfaceForms): void {
  for (const surface of Object.keys(forms)) {
    const value = forms[surface]
    if (Array.isArray(value)) target.add(surface, value[1], value[0])
  }
}

export function createFrozenSurfaceSlot(
  load: () => SerializedSurfaceForms | null,
  documents: FrozenSurfaceDocuments,
  tableOnDisk?: SurfaceTableReader,
): FrozenSurfaceSlot {
  let registry: SurfaceRegistry | null = null
  let uncounted: Uint8Array | null = null
  let table = tableOnDisk
  let removalState: ReturnType<typeof createSurfaceRemovalState> | null = null
  const waitingRemovals = new Map<string, number>()
  let waitingBytes = 0

  function subtractWaitingRemovals(target: SurfaceRegistry): void {
    for (const [spelling, count] of waitingRemovals) target.subtract(spelling, count)
  }

  function loaded(): SurfaceRegistry {
    if (registry === null) {
      const built = createSurfaceRegistry()
      const forms = load()
      if (forms !== null) built.deserialize(forms)
      subtractWaitingRemovals(built)
      registry = built
      table = undefined
      waitingRemovals.clear()
      waitingBytes = 0
    }
    return registry
  }

  function isCounted(ordinal: number): boolean {
    return uncounted === null || uncounted[ordinal] === 0
  }

  function prepareRemoval(ordinal: number, spellings: RemovedSpellings): () => void {
    const marks = uncounted ?? new Uint8Array(documents.count)
    const target = spellings.spellings.length > 0 && table === undefined ? loaded() : null
    return () => {
      uncounted ??= marks
      uncounted[ordinal] = 1
      const { counts } = spellings
      for (let entry = 0; entry < counts.length; entry++) {
        const spelling = spellings.spellings[entry]
        const count = counts[entry]
        if (target !== null) {
          removalState?.subtract(spelling, count)
          target.subtract(spelling, count)
        } else {
          const previous = waitingRemovals.get(spelling)
          if (previous === undefined) waitingBytes += REMOVED_SURFACE_ENTRY_BYTES + documentValueBytes(spelling)
          waitingRemovals.set(spelling, (previous ?? 0) + count)
        }
      }
    }
  }

  return {
    heldBytes: () =>
      (table?.heldBytes() ?? 0) + waitingBytes + (uncounted?.byteLength ?? 0) + (removalState?.bytes() ?? 0),

    reader: {
      candidatesForPrefix: prefix =>
        table !== undefined && waitingRemovals.size === 0
          ? table.candidatesForPrefix(prefix)
          : loaded().candidatesForPrefix(prefix),
      stemChangedTotalFor: token => loaded().stemChangedTotalFor(token),
      size: () => loaded().size(),
      serialize: () => loaded().serialize(),
    },

    tableStaysOnDisk(): boolean {
      return registry === null && tableOnDisk !== undefined
    },

    holdsAny(): boolean {
      return loaded().size() > 0
    },

    tokenOf(surface: string): string | undefined {
      return loaded().tokenOf(surface)
    },

    subtractSpellings(ordinal: number, spellings: RemovedSpellings): void {
      prepareRemoval(ordinal, spellings)()
    },

    prepareRemoval,

    coreRegions() {
      removalState ??= createSurfaceRemovalState(loaded())
      return { table: removalState.table, removed: removalState.removed }
    },

    prepareCoreRemoval(ordinal, spellings) {
      const target = loaded()
      removalState ??= createSurfaceRemovalState(target)
      const marks = uncounted ?? new Uint8Array(documents.count)
      return {
        table: removalState.table,
        removed: removalState.removed,
        publish() {
          uncounted ??= marks
          uncounted[ordinal] = 1
          const { counts } = spellings
          for (let entry = 0; entry < counts.length; entry++) target.subtract(spellings.spellings[entry], counts[entry])
        },
      }
    },

    addKeptForms(target: SurfaceRegistry, mergedOrdinals: Int32Array, analysis: TextAnalysis | null): void {
      const source = loaded()
      if (analysis === null) {
        addForms(target, source.serialize())
        return
      }
      const scoped: PartialWordAnalysis = { ...analysis, fields: documents.textFields }
      let kept = 0
      let corrections = 0
      for (let ordinal = 0; ordinal < mergedOrdinals.length; ordinal++) {
        const keeps = mergedOrdinals[ordinal] >= 0
        if (keeps) kept++
        if (keeps !== isCounted(ordinal)) corrections++
      }
      if (corrections > kept) {
        for (let ordinal = 0; ordinal < mergedOrdinals.length; ordinal++) {
          if (mergedOrdinals[ordinal] >= 0) applyDocumentSurfaces(target, documents.documentAt(ordinal), scoped, 1)
        }
        return
      }
      const corrected = createSurfaceRegistry()
      addForms(corrected, source.serialize())
      for (let ordinal = 0; ordinal < mergedOrdinals.length; ordinal++) {
        const keeps = mergedOrdinals[ordinal] >= 0
        if (keeps === isCounted(ordinal)) continue
        applyDocumentSurfaces(corrected, documents.documentAt(ordinal), scoped, keeps ? 1 : -1)
      }
      addForms(target, corrected.serialize())
    },
  }
}
