import { evaluateFilters, type FilterContext } from '../../filters/evaluator'
import { schemaFieldsOf } from '../../schema/validator'
import { parsedTypeOf } from '../../schema/validator/field-type'
import type { FilterExpression } from '../../types/filters'
import type { FieldType, SchemaDefinition } from '../../types/schema'
import { bitsetHas, createBitSet } from '../bitset'
import { patternHost } from '../pattern-index/host'
import { requirePatternSearch } from '../pattern-index/registry'
import type { PatternOperator, PatternTolerance, PatternWorkMeter } from '../pattern-index/types'
import type { TextRangeBounds } from './sort-columns/range'
import { textRangeBitsetOf } from './sorting'
import { getFlatSchema, type PartitionReadState } from './utils'
import { keepsValueSize } from './value-sizes'

function presentBitsetOf(
  state: PartitionReadState,
  fieldPath: string,
  type: FieldType | undefined,
  capacity: number,
): Uint32Array {
  const base = parsedTypeOf(type)?.base
  let present: Uint32Array | undefined
  if (base === 'number') present = state.numericIndexes.get(fieldPath)?.getAllDocIdsBitset(capacity)
  else if (base === 'boolean') present = state.booleanIndexes.get(fieldPath)?.getAllDocIdsBitset(capacity)
  else if (base === 'enum') present = state.enumIndexes.get(fieldPath)?.getAllDocIdsBitset(capacity)
  else if (base === 'geopoint') present = state.geoIndexes.get(fieldPath)?.presentOrdinals(capacity)
  else if (base !== undefined && keepsValueSize(base)) {
    present = state.sizeIndexes.get(fieldPath)?.getAllDocIdsBitset(capacity)
  }
  return present ?? createBitSet(capacity)
}

export function buildFilterContext(
  state: PartitionReadState,
  schema: SchemaDefinition,
  meter: PatternWorkMeter,
): FilterContext {
  const flat = getFlatSchema(state, schema)
  const capacity = state.docStore.internalIdCapacity()
  const patternFields = new Set<string>()
  for (const { path: fieldPath, pattern } of schemaFieldsOf(schema)) {
    if (pattern) patternFields.add(fieldPath)
  }
  const cachedPresentBitsets = new Map<string, Uint32Array>()

  return {
    fieldTypes: flat,
    numericIndex: fieldPath => state.numericIndexes.get(fieldPath),
    booleanIndex: fieldPath => state.booleanIndexes.get(fieldPath),
    enumIndex: fieldPath => state.enumIndexes.get(fieldPath),
    geoIndex: fieldPath => state.geoIndexes.get(fieldPath),
    sizeIndex: fieldPath => state.sizeIndexes.get(fieldPath),
    textRangeBitset: (fieldPath: string, bounds: TextRangeBounds) =>
      textRangeBitsetOf(state, fieldPath, flat[fieldPath], bounds, capacity),
    isPatternField: (fieldPath: string) => patternFields.has(fieldPath),
    matchPattern: (
      fieldPath: string,
      operator: PatternOperator,
      text: string,
      caseFold: boolean,
      tolerance: PatternTolerance,
      into: Uint32Array,
    ) => {
      const index = state.patternIndexes.get(fieldPath)
      if (index === undefined) return
      const pattern = requirePatternSearch(fieldPath)
      pattern.matchInto({
        operator,
        text,
        caseFold,
        tolerance,
        index,
        matches: into,
        meter,
        host: patternHost(),
        values: pattern.storedValues(state.docStore, fieldPath),
      })
    },
    presentBitset: (fieldPath: string) => {
      const cached = cachedPresentBitsets.get(fieldPath)
      if (cached !== undefined) return cached
      const present = presentBitsetOf(state, fieldPath, flat[fieldPath], capacity)
      cachedPresentBitsets.set(fieldPath, present)
      return present
    },
    capacity,
    get allDocIdsBitset() {
      return state.docStore.liveOrdinals()
    },
  }
}

export function applyPartitionFilters(
  state: PartitionReadState,
  filters: FilterExpression,
  schema: SchemaDefinition,
  meter: PatternWorkMeter,
): Set<string> {
  const context = buildFilterContext(state, schema, meter)
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
  meter: PatternWorkMeter,
): Uint32Array {
  const context = buildFilterContext(state, schema, meter)
  return evaluateFilters(filters, context)
}

export interface PartitionFilterMatches {
  ordinalBitset(): Uint32Array
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
  meter: PatternWorkMeter,
): PartitionFilterMatches {
  const accepted = applyPartitionFiltersBitset(state, filters, schema, meter)
  const docStore = state.docStore
  const resolver = docStore.resolver()

  let count = 0
  for (let wordIndex = 0; wordIndex < accepted.length; wordIndex++) {
    let word = accepted[wordIndex]
    if (word === 0) continue
    const base = wordIndex << 5
    while (word !== 0) {
      const trailingZeros = Math.clz32(word & -word) ^ 31
      if (resolver.isLive(base + trailingZeros)) count++
      word &= word - 1
    }
  }

  return {
    count,
    ordinalBitset: () => accepted,
    hasExternal(docId: string): boolean {
      const internalId = docStore.getInternalId(docId)
      return internalId !== undefined && bitsetHas(accepted, internalId)
    },
    hasInternal(internalId: number): boolean {
      return bitsetHas(accepted, internalId)
    },
  }
}
