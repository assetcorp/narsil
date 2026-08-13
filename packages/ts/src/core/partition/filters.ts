import { evaluateFilters, type FilterContext } from '../../filters/evaluator'
import type { FieldIndex, GeoFieldIndex } from '../../filters/operators'
import type { FilterExpression } from '../../types/filters'
import type { SchemaDefinition } from '../../types/schema'
import { bitsetFromSet, bitsetHas } from '../bitset'
import { getAllInternalDocIds, getFieldValueByInternalId, getFlatSchema, type PartitionReadState } from './utils'

export function buildFilterContext(state: PartitionReadState, schema: SchemaDefinition): FilterContext {
  const flat = getFlatSchema(state, schema)
  const fieldIndexes: Record<string, FieldIndex> = {}
  const capacity = state.docStore.internalIdCapacity()

  for (const [fieldPath, fieldType] of Object.entries(flat)) {
    if (fieldType === 'number' || fieldType === 'number[]') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        fieldIndexes[fieldPath] = {
          type: 'numeric',
          index: {
            eq: (v: number) => numIdx.queryEq(v),
            gt: (v: number) => numIdx.queryGt(v),
            gte: (v: number) => numIdx.queryGte(v),
            lt: (v: number) => numIdx.queryLt(v),
            lte: (v: number) => numIdx.queryLte(v),
            between: (min: number, max: number) => numIdx.queryBetween(min, max),
            allDocIds: () => numIdx.getAllDocIds(),
            eqBitset: (v: number, cap: number) => numIdx.queryEqBitset(v, cap),
            gtBitset: (v: number, cap: number) => numIdx.queryGtBitset(v, cap),
            gteBitset: (v: number, cap: number) => numIdx.queryGteBitset(v, cap),
            ltBitset: (v: number, cap: number) => numIdx.queryLtBitset(v, cap),
            lteBitset: (v: number, cap: number) => numIdx.queryLteBitset(v, cap),
            betweenBitset: (min: number, max: number, cap: number) => numIdx.queryBetweenBitset(min, max, cap),
            allDocIdsBitset: (cap: number) => numIdx.getAllDocIdsBitset(cap),
          },
        }
      }
    } else if (fieldType === 'boolean' || fieldType === 'boolean[]') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        fieldIndexes[fieldPath] = {
          type: 'boolean',
          index: {
            getTrue: () => boolIdx.queryEq(true),
            getFalse: () => boolIdx.queryEq(false),
            allDocIds: () => boolIdx.getAllDocIds(),
            getTrueBitset: (cap: number) => boolIdx.queryEqBitset(true, cap),
            getFalseBitset: (cap: number) => boolIdx.queryEqBitset(false, cap),
            allDocIdsBitset: (cap: number) => boolIdx.getAllDocIdsBitset(cap),
          },
        }
      }
    } else if (fieldType === 'enum' || fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        fieldIndexes[fieldPath] = {
          type: 'enum',
          index: {
            getDocIds: (v: string) => enumIdx.queryEq(v),
            allDocIds: () => enumIdx.getAllDocIds(),
            getDocIdsBitset: (v: string, cap: number) => enumIdx.queryEqBitset(v, cap),
            getDocIdsInBitset: (values: string[], cap: number) => enumIdx.queryInBitset(values, cap),
            allDocIdsBitset: (cap: number) => enumIdx.getAllDocIdsBitset(cap),
          },
        }
      }
    } else if (fieldType === 'geopoint') {
      const geoIdx = state.geoIndexes.get(fieldPath)
      if (geoIdx) {
        fieldIndexes[fieldPath] = {
          type: 'geopoint',
          index: geoIdx as GeoFieldIndex,
        }
      }
    }
  }

  let cachedAllDocIds: Set<number> | null = null
  let cachedAllDocIdsBitset: Uint32Array | null = null

  return {
    fieldIndexes,
    getFieldValue: (internalId: number, fieldPath: string) =>
      getFieldValueByInternalId(state.docStore, internalId, fieldPath),
    get allDocIds() {
      if (!cachedAllDocIds) {
        cachedAllDocIds = getAllInternalDocIds(state.docStore)
      }
      return cachedAllDocIds
    },
    capacity,
    get allDocIdsBitset() {
      if (!cachedAllDocIdsBitset) {
        cachedAllDocIdsBitset = bitsetFromSet(this.allDocIds, capacity)
      }
      return cachedAllDocIdsBitset
    },
  }
}

export function applyPartitionFilters(
  state: PartitionReadState,
  filters: FilterExpression,
  schema: SchemaDefinition,
): Set<string> {
  const context = buildFilterContext(state, schema)
  const resultBitset = evaluateFilters(filters, context)
  const resolver = state.docStore.resolver()
  const externalResult = new Set<string>()
  for (let wi = 0; wi < resultBitset.length; wi++) {
    let word = resultBitset[wi]
    if (word === 0) continue
    const base = wi << 5
    while (word !== 0) {
      const tz = Math.clz32(word & -word) ^ 31
      const internalId = base + tz
      const externalId = resolver.toExternal(internalId)
      if (externalId !== undefined) {
        externalResult.add(externalId)
      }
      word &= word - 1
    }
  }
  return externalResult
}

export function applyPartitionFiltersBitset(
  state: PartitionReadState,
  filters: FilterExpression,
  schema: SchemaDefinition,
): Uint32Array {
  const context = buildFilterContext(state, schema)
  return evaluateFilters(filters, context)
}

/**
 * The documents of one partition that a filter accepts, held as a bit per
 * ordinal rather than as a set of document ids.
 *
 * @internal
 */
export interface PartitionFilterMatches {
  /** This many stored documents pass the filter. */
  readonly count: number
  /** Reports whether the named document passes the filter. */
  hasExternal(docId: string): boolean
  /** Reports whether the document at this ordinal passes the filter. */
  hasInternal(internalId: number): boolean
}

export function partitionFilterMatches(
  state: PartitionReadState,
  filters: FilterExpression,
  schema: SchemaDefinition,
): PartitionFilterMatches {
  const accepted = applyPartitionFiltersBitset(state, filters, schema)
  const docStore = state.docStore
  const resolver = docStore.resolver()

  let count = 0
  for (let wordIndex = 0; wordIndex < accepted.length; wordIndex++) {
    let word = accepted[wordIndex]
    if (word === 0) continue
    const base = wordIndex << 5
    while (word !== 0) {
      const trailingZeros = Math.clz32(word & -word) ^ 31
      if (resolver.toExternal(base + trailingZeros) !== undefined) count++
      word &= word - 1
    }
  }

  return {
    count,
    hasExternal(docId: string): boolean {
      const internalId = docStore.getInternalId(docId)
      return internalId !== undefined && bitsetHas(accepted, internalId)
    },
    hasInternal(internalId: number): boolean {
      return bitsetHas(accepted, internalId)
    },
  }
}
