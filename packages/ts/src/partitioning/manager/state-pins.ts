import type { ComparableSortValue, SortMode } from '../../core/ordering'
import type { PartitionIndex } from '../../core/partition'
import { getNestedValue } from '../../core/partition/utils'
import { cloneProjected, projectionKeepsField, type ResolvedProjection } from '../../core/projection'
import {
  documentStoredFields,
  partitionStoredFields,
  type StoredFieldReference,
} from '../../core/stored-values/references'
import { reduceSortValue as toReducedSortValue } from '../../search/sorting-code'
import type { AnyDocument } from '../../types/schema'
import { setNestedValue } from './nested-values'

/** A document as a pinned state held it, before a later write changed it. */
export interface PriorDocument {
  readonly document: AnyDocument | undefined
  readonly ref: AnyDocument | undefined
  readonly partitionId: number | undefined
}

/** The reads that a search makes of the documents behind its hits. */
export interface HitReads {
  get(docId: string, projection?: ResolvedProjection): AnyDocument | undefined
  getRef(docId: string): AnyDocument | undefined
  fieldValues(docId: string, fieldPaths: readonly string[]): unknown[] | undefined
  storedFields(docId: string, fieldPaths: readonly string[]): StoredFieldReference[] | undefined
  sortValues(
    docId: string,
    fields: readonly string[],
    fieldTypes: readonly (string | undefined)[],
    modes: readonly SortMode[],
  ): ComparableSortValue[]
}

/** What the pins read from the current state of an index. */
export interface PinnedReads extends HitReads {
  partitionIdOf(docId: string): number | undefined
  vectorsInto(document: AnyDocument, docId: string, projection: ResolvedProjection | undefined): void
}

/**
 * One state of an index that a search answers from. Every write after the pin
 * records the document as the pinned state held it, and every partition that a
 * replacement takes out stays readable through the pin, so every read through
 * the pin returns that state however many writes arrive while the search waits.
 */
export interface StatePin extends HitReads {
  /** The documents that writes changed after the pin, keyed by document ID. */
  readonly changed: ReadonlyMap<string, PriorDocument>
  has(docId: string): boolean
  partitionIdOf(docId: string): number | undefined
  /** Writes the vector fields of the document as the pinned state held them into a document that another copy read. */
  vectorsInto(document: AnyDocument, docId: string, projection: ResolvedProjection | undefined): void
  release(): void
}

export interface StatePins {
  readonly held: number
  open(reads: PinnedReads): StatePin
  /** Records a document as every open pin holds it, before a write changes it. */
  beforeWrite(docId: string): void
  /**
   * Keeps the partitions that a replacement took out of the index readable
   * through every open pin, and calls free once the last of those pins
   * releases.
   */
  detach(partitions: readonly PartitionIndex[], free: () => void): void
  /** Calls free once every pin open right now has released, or at once where none is open. */
  afterRelease(free: () => void): void
}

interface PinRegistry {
  release(held: HeldState): void
  vectorFieldPaths(): readonly string[]
}

interface Retirement {
  readonly holders: Set<HeldState>
  readonly free: () => void
}

/**
 * Reads the fields of documents that a search already holds, the way a
 * partition reads them from its document store.
 */
export function documentFieldValues(ref: AnyDocument, fieldPaths: readonly string[]): unknown[] {
  return fieldPaths.map(fieldPath => getNestedValue(ref as Record<string, unknown>, fieldPath))
}

/** Reduces the sort fields of a document that a search already holds, the way a partition reduces them. */
export function documentSortValues(
  ref: AnyDocument | undefined,
  fields: readonly string[],
  modes: readonly SortMode[],
): ComparableSortValue[] {
  if (ref === undefined) return fields.map(() => null)
  return fields.map((field, at) =>
    toReducedSortValue(getNestedValue(ref as Record<string, unknown>, field), modes[at] ?? 'min'),
  )
}

function copyPriorVectors(
  document: AnyDocument,
  prior: AnyDocument | undefined,
  vectorFieldPaths: readonly string[],
  projection: ResolvedProjection | undefined,
): void {
  if (prior === undefined) return
  for (const fieldPath of vectorFieldPaths) {
    if (projection !== undefined && !projectionKeepsField(projection, fieldPath)) continue
    const vector = getNestedValue(prior as Record<string, unknown>, fieldPath)
    if (vector !== undefined) setNestedValue(document as Record<string, unknown>, fieldPath, vector)
  }
}

function priorOf(reads: PinnedReads, docId: string): PriorDocument {
  return {
    document: reads.get(docId),
    ref: reads.getRef(docId),
    partitionId: reads.partitionIdOf(docId),
  }
}

const NO_CHANGES: ReadonlyMap<string, PriorDocument> = new Map()

class HeldState implements StatePin, PinnedReads {
  priors: Map<string, PriorDocument> | undefined
  detached: PartitionIndex[] | undefined

  constructor(
    readonly reads: PinnedReads,
    private readonly registry: PinRegistry,
  ) {}

  get changed(): ReadonlyMap<string, PriorDocument> {
    return this.priors ?? NO_CHANGES
  }

  notePrior(docId: string, prior: PriorDocument): void {
    this.priors ??= new Map()
    this.priors.set(docId, prior)
  }

  private ownerOf(docId: string): PartitionIndex | undefined {
    const detached = this.detached
    if (detached === undefined) return undefined
    for (const partition of detached) if (partition.has(docId)) return partition
    return undefined
  }

  get(docId: string, projection?: ResolvedProjection): AnyDocument | undefined {
    if (this.priors === undefined && this.detached === undefined) return this.reads.get(docId, projection)
    return this.getRetained(docId, projection)
  }

  private getRetained(docId: string, projection: ResolvedProjection | undefined): AnyDocument | undefined {
    const prior = this.priors?.get(docId)
    if (prior !== undefined)
      return prior.document === undefined ? undefined : cloneProjected(prior.document, projection)
    const owner = this.ownerOf(docId)
    if (owner === undefined) return this.reads.get(docId, projection)
    const document = owner.get(docId, projection)
    if (document !== undefined) this.reads.vectorsInto(document, docId, projection)
    return document
  }

  getRef(docId: string): AnyDocument | undefined {
    const prior = this.priors?.get(docId)
    return prior === undefined ? (this.ownerOf(docId) ?? this.reads).getRef(docId) : prior.ref
  }

  has(docId: string): boolean {
    const prior = this.priors?.get(docId)
    return prior === undefined ? this.partitionIdOf(docId) !== undefined : prior.ref !== undefined
  }

  partitionIdOf(docId: string): number | undefined {
    const prior = this.priors?.get(docId)
    if (prior !== undefined) return prior.partitionId
    const owner = this.ownerOf(docId)
    return owner === undefined ? this.reads.partitionIdOf(docId) : owner.partitionId
  }

  fieldValues(docId: string, fieldPaths: readonly string[]): unknown[] | undefined {
    const prior = this.priors?.get(docId)
    if (prior === undefined) return (this.ownerOf(docId) ?? this.reads).fieldValues(docId, fieldPaths)
    return prior.ref === undefined ? undefined : documentFieldValues(prior.ref, fieldPaths)
  }

  storedFields(docId: string, fieldPaths: readonly string[]): StoredFieldReference[] | undefined {
    const prior = this.priors?.get(docId)
    if (prior !== undefined) return documentStoredFields(prior.ref, fieldPaths)
    const owner = this.ownerOf(docId)
    return owner === undefined
      ? this.reads.storedFields(docId, fieldPaths)
      : partitionStoredFields(owner, docId, fieldPaths)
  }

  sortValues(
    docId: string,
    fields: readonly string[],
    fieldTypes: readonly (string | undefined)[],
    modes: readonly SortMode[],
  ): ComparableSortValue[] {
    const prior = this.priors?.get(docId)
    if (prior === undefined) return (this.ownerOf(docId) ?? this.reads).sortValues(docId, fields, fieldTypes, modes)
    return documentSortValues(prior.ref, fields, modes)
  }

  vectorsInto(document: AnyDocument, docId: string, projection: ResolvedProjection | undefined): void {
    const prior = this.priors?.get(docId)
    if (prior === undefined) this.reads.vectorsInto(document, docId, projection)
    else copyPriorVectors(document, prior.document, this.registry.vectorFieldPaths(), projection)
  }

  release(): void {
    this.registry.release(this)
  }
}

export function createStatePins(vectorFieldPaths: () => readonly string[]): StatePins {
  const open: HeldState[] = []
  const retirements = new Set<Retirement>()

  const registry: PinRegistry = {
    release(held) {
      const at = open.indexOf(held)
      if (at === -1) return
      const last = open.pop()
      if (last !== undefined && at < open.length) open[at] = last
      held.priors = undefined
      held.detached = undefined
      if (retirements.size === 0) return
      for (const retirement of retirements) {
        if (!retirement.holders.delete(held) || retirement.holders.size > 0) continue
        retirements.delete(retirement)
        retirement.free()
      }
    },
    vectorFieldPaths,
  }

  return {
    get held() {
      return open.length
    },
    open(reads) {
      const held = new HeldState(reads, registry)
      open.push(held)
      return held
    },
    beforeWrite(docId) {
      if (open.length === 0) return
      let sharedReads: PinnedReads | undefined
      let shared: PriorDocument | undefined
      let otherPriors: Map<PinnedReads, PriorDocument> | undefined
      for (const held of open) {
        if (held.priors?.has(docId)) continue
        if (held.detached !== undefined) {
          held.notePrior(docId, priorOf(held, docId))
          continue
        }
        if (shared === undefined) {
          sharedReads = held.reads
          shared = priorOf(held.reads, docId)
        }
        if (held.reads === sharedReads) {
          held.notePrior(docId, shared)
          continue
        }
        otherPriors ??= new Map()
        let prior = otherPriors.get(held.reads)
        if (prior === undefined) {
          prior = priorOf(held.reads, docId)
          otherPriors.set(held.reads, prior)
        }
        held.notePrior(docId, prior)
      }
    },
    detach(partitions, free) {
      if (open.length === 0 || partitions.length === 0) {
        free()
        return
      }
      for (const held of open) {
        held.detached ??= []
        held.detached.push(...partitions)
      }
      retirements.add({ holders: new Set(open), free })
    },
    afterRelease(free) {
      if (open.length === 0) {
        free()
        return
      }
      retirements.add({ holders: new Set(open), free })
    },
  }
}
