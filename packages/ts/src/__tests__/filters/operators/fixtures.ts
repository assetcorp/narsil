import { bitsetFromSet } from '../../../core/bitset'
import type { BooleanFieldIndex, EnumFieldIndex, GetFieldValue, NumericFieldIndex } from '../../../filters/operators'

export function createMockNumericIndex(entries: Array<{ value: number; docId: number }>): NumericFieldIndex {
  const toSet = (filter: (e: { value: number; docId: number }) => boolean) =>
    new Set(entries.filter(filter).map(e => e.docId))
  const toBitset = (filter: (e: { value: number; docId: number }) => boolean, cap: number) =>
    bitsetFromSet(toSet(filter), cap)
  return {
    eq: (v: number) => toSet(e => e.value === v),
    gt: (v: number) => toSet(e => e.value > v),
    gte: (v: number) => toSet(e => e.value >= v),
    lt: (v: number) => toSet(e => e.value < v),
    lte: (v: number) => toSet(e => e.value <= v),
    between: (min: number, max: number) => toSet(e => e.value >= min && e.value <= max),
    allDocIds: () => new Set(entries.map(e => e.docId)),
    eqBitset: (v: number, cap: number) => toBitset(e => e.value === v, cap),
    gtBitset: (v: number, cap: number) => toBitset(e => e.value > v, cap),
    gteBitset: (v: number, cap: number) => toBitset(e => e.value >= v, cap),
    ltBitset: (v: number, cap: number) => toBitset(e => e.value < v, cap),
    lteBitset: (v: number, cap: number) => toBitset(e => e.value <= v, cap),
    betweenBitset: (min: number, max: number, cap: number) => toBitset(e => e.value >= min && e.value <= max, cap),
    allDocIdsBitset: (cap: number) => bitsetFromSet(new Set(entries.map(e => e.docId)), cap),
  }
}

export function createMockBooleanIndex(trueDocs: number[], falseDocs: number[]): BooleanFieldIndex {
  return {
    getTrue: () => new Set(trueDocs),
    getFalse: () => new Set(falseDocs),
    allDocIds: () => new Set([...trueDocs, ...falseDocs]),
    getTrueBitset: (cap: number) => bitsetFromSet(new Set(trueDocs), cap),
    getFalseBitset: (cap: number) => bitsetFromSet(new Set(falseDocs), cap),
    allDocIdsBitset: (cap: number) => bitsetFromSet(new Set([...trueDocs, ...falseDocs]), cap),
  }
}

export function createMockEnumIndex(mapping: Record<string, number[]>): EnumFieldIndex {
  function allDocs(): Set<number> {
    const all = new Set<number>()
    for (const docIds of Object.values(mapping)) {
      for (const id of docIds) all.add(id)
    }
    return all
  }
  return {
    getDocIds: (value: string) => new Set(mapping[value] ?? []),
    allDocIds: allDocs,
    getDocIdsBitset: (value: string, cap: number) => bitsetFromSet(new Set(mapping[value] ?? []), cap),
    getDocIdsInBitset: (values: string[], cap: number) => {
      const combined = new Set<number>()
      for (const val of values) {
        for (const id of mapping[val] ?? []) combined.add(id)
      }
      return bitsetFromSet(combined, cap)
    },
    allDocIdsBitset: (cap: number) => bitsetFromSet(allDocs(), cap),
  }
}

export const docs: Record<number, Record<string, unknown>> = {
  0: { name: 'Alice', age: 30, active: true, category: 'electronics', tags: ['a', 'b'], city: '' },
  1: { name: 'Bob', age: 25, active: false, category: 'books', tags: ['b', 'c'] },
  2: { name: 'Charlie', age: 35, active: true, category: 'electronics', tags: ['a'] },
  3: { name: 'Diana', age: 28, active: false, category: 'clothing', tags: [] },
}

export const allDocIds = new Set([0, 1, 2, 3])

export function getValue(field: string): GetFieldValue {
  return (id: number) => docs[id]?.[field]
}
