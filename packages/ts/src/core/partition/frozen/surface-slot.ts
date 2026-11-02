import type { SerializedSurfaceForms } from '../../../types/internal'
import type { AnyDocument } from '../../../types/schema'
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

export type TextAnalysis = Omit<PartialWordAnalysis, 'fields'>

export type RemovedSpellings = readonly string[]

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
  subtractOnceLoaded(ordinal: number, analysis: PartialWordAnalysis): void
  holdsAny(): boolean
  holds(spelling: string): boolean
  subtractSpellings(ordinal: number, spellings: RemovedSpellings): void
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
  let waitingRemovals: number[] = []
  let waitingAnalysis: PartialWordAnalysis | null = null

  function subtractWaitingRemovals(target: SurfaceRegistry): void {
    if (waitingAnalysis === null || target.size() === 0) return
    for (const ordinal of waitingRemovals) {
      const spellings: string[] = []
      visitDocumentSurfaceSpellings(documents.documentAt(ordinal), waitingAnalysis, spelling => {
        if (target.holds(spelling)) spellings.push(spelling)
      })
      for (const spelling of spellings) target.subtract(spelling, 1)
    }
  }

  function loaded(): SurfaceRegistry {
    if (registry === null) {
      const built = createSurfaceRegistry()
      const forms = load()
      if (forms !== null) built.deserialize(forms)
      subtractWaitingRemovals(built)
      registry = built
      table = undefined
      waitingRemovals = []
      waitingAnalysis = null
    }
    return registry
  }

  function isCounted(ordinal: number): boolean {
    return uncounted === null || uncounted[ordinal] === 0
  }

  return {
    heldBytes: () => table?.heldBytes() ?? 0,

    reader: {
      candidatesForPrefix: prefix =>
        table !== undefined && waitingRemovals.length === 0
          ? table.candidatesForPrefix(prefix)
          : loaded().candidatesForPrefix(prefix),
      stemChangedTotalFor: token => loaded().stemChangedTotalFor(token),
      size: () => loaded().size(),
      serialize: () => loaded().serialize(),
    },

    tableStaysOnDisk(): boolean {
      return registry === null && tableOnDisk !== undefined
    },

    subtractOnceLoaded(ordinal: number, analysis: PartialWordAnalysis): void {
      uncounted ??= new Uint8Array(documents.count)
      uncounted[ordinal] = 1
      waitingAnalysis = analysis
      waitingRemovals.push(ordinal)
    },

    holdsAny(): boolean {
      return loaded().size() > 0
    },

    holds(spelling: string): boolean {
      return loaded().holds(spelling)
    },

    subtractSpellings(ordinal: number, spellings: RemovedSpellings): void {
      uncounted ??= new Uint8Array(documents.count)
      uncounted[ordinal] = 1
      if (spellings.length === 0) return
      const target = loaded()
      for (const spelling of spellings) target.subtract(spelling, 1)
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
