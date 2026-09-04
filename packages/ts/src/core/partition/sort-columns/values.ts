import { type ComparableSortValue, toComparableSortValue } from '../../ordering'
import { SORT_VALUE_MAX_CODE_POINTS } from '../../ordering/constants'

export type ValueStoreKind = 'number' | 'boolean' | 'mixed'

const BOOLEAN_FALSE = 0
const BOOLEAN_TRUE = 1
const BOOLEAN_MISSING = 2

const BYTES_PER_NUMBER_SLOT = 8
const BYTES_PER_BOOLEAN_SLOT = 1
const BYTES_PER_MIXED_SLOT = 8
const BYTES_PER_STRING_CODE_UNIT = 2
const STRING_HEADER_BYTES = 24

export interface ValueStore {
  readonly kind: ValueStoreKind
  set(internalId: number, value: unknown): void
  clear(internalId: number): void
  get(internalId: number): ComparableSortValue
  estimateBytes(): number
}

function grow(length: number, wanted: number): number {
  let next = length === 0 ? 64 : length
  while (next <= wanted) next *= 2
  return next
}

export function kindForFieldType(fieldType: string | undefined): ValueStoreKind {
  if (fieldType === 'number') return 'number'
  if (fieldType === 'boolean') return 'boolean'
  return 'mixed'
}

export function createValueStore(initialKind: ValueStoreKind): ValueStore {
  let kind = initialKind
  let numbers = initialKind === 'number' ? new Float64Array(0) : null
  let booleans = initialKind === 'boolean' ? new Uint8Array(0) : null
  let mixed: ComparableSortValue[] = []

  function demote(): void {
    const promoted: ComparableSortValue[] = []
    if (numbers !== null) {
      for (let id = 0; id < numbers.length; id++) {
        promoted[id] = Number.isNaN(numbers[id]) ? null : numbers[id]
      }
    } else if (booleans !== null) {
      for (let id = 0; id < booleans.length; id++) {
        promoted[id] = booleans[id] === BOOLEAN_MISSING ? null : booleans[id] === BOOLEAN_TRUE
      }
    }
    numbers = null
    booleans = null
    mixed = promoted
    kind = 'mixed'
  }

  function setNumber(internalId: number, value: number): void {
    if (numbers === null) return
    if (internalId >= numbers.length) {
      const grown = new Float64Array(grow(numbers.length, internalId))
      grown.fill(Number.NaN, numbers.length)
      grown.set(numbers)
      numbers = grown
    }
    numbers[internalId] = value
  }

  function setBoolean(internalId: number, value: number): void {
    if (booleans === null) return
    if (internalId >= booleans.length) {
      const grown = new Uint8Array(grow(booleans.length, internalId))
      grown.fill(BOOLEAN_MISSING, booleans.length)
      grown.set(booleans)
      booleans = grown
    }
    booleans[internalId] = value
  }

  function setMixed(internalId: number, value: ComparableSortValue): void {
    while (mixed.length <= internalId) mixed.push(null)
    mixed[internalId] = value
  }

  const store: ValueStore = {
    get kind() {
      return kind
    },

    set(internalId: number, value: unknown): void {
      const comparable = toComparableSortValue(value)
      if (kind === 'number') {
        if (comparable === null) {
          setNumber(internalId, Number.NaN)
          return
        }
        if (typeof comparable !== 'number') {
          demote()
          setMixed(internalId, comparable)
          return
        }
        setNumber(internalId, comparable)
        return
      }
      if (kind === 'boolean') {
        if (comparable === null) {
          setBoolean(internalId, BOOLEAN_MISSING)
          return
        }
        if (typeof comparable !== 'boolean') {
          demote()
          setMixed(internalId, comparable)
          return
        }
        setBoolean(internalId, comparable ? BOOLEAN_TRUE : BOOLEAN_FALSE)
        return
      }
      setMixed(internalId, comparable)
    },

    clear(internalId: number): void {
      if (numbers !== null) {
        if (internalId < numbers.length) numbers[internalId] = Number.NaN
        return
      }
      if (booleans !== null) {
        if (internalId < booleans.length) booleans[internalId] = BOOLEAN_MISSING
        return
      }
      if (internalId < mixed.length) mixed[internalId] = null
    },

    get(internalId: number): ComparableSortValue {
      if (numbers !== null) {
        if (internalId >= numbers.length) return null
        const value = numbers[internalId]
        return Number.isNaN(value) ? null : value
      }
      if (booleans !== null) {
        if (internalId >= booleans.length) return null
        const value = booleans[internalId]
        return value === BOOLEAN_MISSING ? null : value === BOOLEAN_TRUE
      }
      if (internalId >= mixed.length) return null
      return mixed[internalId]
    },

    estimateBytes(): number {
      if (numbers !== null) return numbers.length * BYTES_PER_NUMBER_SLOT
      if (booleans !== null) return booleans.length * BYTES_PER_BOOLEAN_SLOT
      let bytes = mixed.length * BYTES_PER_MIXED_SLOT
      for (const value of mixed) {
        if (typeof value !== 'string') continue
        if (value.length < SORT_VALUE_MAX_CODE_POINTS) continue
        bytes += STRING_HEADER_BYTES + value.length * BYTES_PER_STRING_CODE_UNIT
      }
      return bytes
    },
  }

  return store
}
