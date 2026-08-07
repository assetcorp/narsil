import { describe, expect, it } from 'vitest'
import {
  buildOrder,
  MISSING_RANK,
  rankIsBetweenValues,
  rankOfValue,
  seekPosition,
} from '../../../core/partition/sort-columns/order'
import { createValueStore, kindForFieldType } from '../../../core/partition/sort-columns/values'

function storeOf(fieldType: string | undefined, values: unknown[]) {
  const store = createValueStore(kindForFieldType(fieldType))
  for (let internalId = 0; internalId < values.length; internalId++) {
    store.set(internalId, values[internalId])
  }
  return store
}

function idsOf(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

describe('the value store a sort column reads', () => {
  it('holds a number field in a packed form and reads a missing value back as missing', () => {
    const store = storeOf('number', [10, undefined, 30])

    expect(store.kind).toBe('number')
    expect(store.get(0)).toBe(10)
    expect(store.get(1)).toBeNull()
    expect(store.get(2)).toBe(30)
  })

  it('counts a number that is not finite as missing', () => {
    const store = storeOf('number', [Number.POSITIVE_INFINITY, Number.NaN, 3])

    expect(store.get(0)).toBeNull()
    expect(store.get(1)).toBeNull()
    expect(store.get(2)).toBe(3)
  })

  it('holds a boolean field in a packed form', () => {
    const store = storeOf('boolean', [true, false, undefined])

    expect(store.kind).toBe('boolean')
    expect(store.get(0)).toBe(true)
    expect(store.get(1)).toBe(false)
    expect(store.get(2)).toBeNull()
  })

  it('keeps every earlier value when a number field receives text', () => {
    const store = storeOf('number', [10, 20, 30])
    store.set(3, 'thirty five')

    expect(store.kind).toBe('mixed')
    expect(store.get(0)).toBe(10)
    expect(store.get(1)).toBe(20)
    expect(store.get(2)).toBe(30)
    expect(store.get(3)).toBe('thirty five')
  })

  it('keeps every earlier value when a boolean field receives a number', () => {
    const store = storeOf('boolean', [true, false])
    store.set(2, 7)

    expect(store.kind).toBe('mixed')
    expect(store.get(0)).toBe(true)
    expect(store.get(1)).toBe(false)
    expect(store.get(2)).toBe(7)
  })

  it('cuts a text value to the comparison window', () => {
    const store = storeOf(undefined, ['x'.repeat(600)])
    const value = store.get(0)

    expect(typeof value).toBe('string')
    expect((value as string).length).toBe(512)
  })

  it('reads a cleared slot back as missing', () => {
    const store = storeOf('number', [10, 20])
    store.clear(0)

    expect(store.get(0)).toBeNull()
    expect(store.get(1)).toBe(20)
  })
})

describe('the order a sort column builds in bulk', () => {
  it('ranks equal values together and groups the documents in rank order', () => {
    const store = storeOf('number', [30, 10, 20, 10])
    const order = buildOrder(store, idsOf(4), 4)

    expect(order.values).toEqual([10, 20, 30])
    expect(order.ranks[1]).toBe(order.ranks[3])
    expect(Array.from(order.ordered).map(id => store.get(id))).toEqual([10, 10, 20, 30])
    expect(order.missing.length).toBe(0)
  })

  it('holds a document with no value apart from the ranked ones', () => {
    const store = storeOf('number', [5, undefined, 1])
    const order = buildOrder(store, idsOf(3), 3)

    expect(order.ranks[1]).toBe(MISSING_RANK)
    expect(Array.from(order.missing)).toEqual([1])
    expect(Array.from(order.ordered)).toEqual([2, 0])
  })

  it('ranks numbers before strings before booleans', () => {
    const store = storeOf(undefined, [true, 'apple', 7])
    const order = buildOrder(store, idsOf(3), 3)

    expect(order.values).toEqual([7, 'apple', true])
  })

  it('places a value the build never saw between the two it sits between', () => {
    const store = storeOf('number', [10, 20, 30])
    const order = buildOrder(store, idsOf(3), 3)

    expect(rankOfValue(order, 20)).toBe(order.ranks[1])
    expect(rankOfValue(order, 15)).toBeGreaterThan(order.ranks[0])
    expect(rankOfValue(order, 15)).toBeLessThan(order.ranks[1])
    expect(rankOfValue(order, 5)).toBeLessThan(order.ranks[0])
    expect(rankOfValue(order, 35)).toBeGreaterThan(order.ranks[2])
    expect(rankOfValue(order, null)).toBe(MISSING_RANK)
  })

  it('marks a rank that falls between two values, and only such a rank', () => {
    const store = storeOf('number', [10, 20])
    const order = buildOrder(store, idsOf(2), 2)

    expect(rankIsBetweenValues(rankOfValue(order, 15))).toBe(true)
    expect(rankIsBetweenValues(rankOfValue(order, 10))).toBe(false)
    expect(rankIsBetweenValues(MISSING_RANK)).toBe(false)
  })

  it('seeks the first document at or after a rank going up, and the last at or before it going down', () => {
    const store = storeOf('number', [10, 20, 30, 20])
    const order = buildOrder(store, idsOf(4), 4)
    const rankOfTwenty = rankOfValue(order, 20)

    const ascending = seekPosition(order, rankOfTwenty, 'asc')
    expect(store.get(order.ordered[ascending])).toBe(20)
    expect(store.get(order.ordered[ascending - 1])).toBe(10)

    const descending = seekPosition(order, rankOfTwenty, 'desc')
    expect(store.get(order.ordered[descending])).toBe(20)
    expect(store.get(order.ordered[descending + 1])).toBe(30)
  })

  it('reports the whole span when a rank sits past either end', () => {
    const store = storeOf('number', [10, 20])
    const order = buildOrder(store, idsOf(2), 2)

    expect(seekPosition(order, rankOfValue(order, 5), 'asc')).toBe(0)
    expect(seekPosition(order, rankOfValue(order, 50), 'asc')).toBe(2)
    expect(seekPosition(order, rankOfValue(order, 5), 'desc')).toBe(-1)
    expect(seekPosition(order, rankOfValue(order, 50), 'desc')).toBe(1)
  })
})
