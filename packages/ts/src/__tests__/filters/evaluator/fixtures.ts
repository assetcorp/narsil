import { bitsetFromSet, bitsetToSet } from '../../../core/bitset'
import type { FilterContext } from '../../../filters/evaluator'
import { evaluateFilters } from '../../../filters/evaluator'
import type { FieldIndex } from '../../../filters/operators'
import type { FilterExpression } from '../../../types/filters'

export const products: Record<number, Record<string, unknown>> = {
  0: { name: 'Laptop', price: 999, category: 'electronics', inStock: true, tags: ['tech', 'portable'] },
  1: { name: 'Novel', price: 15, category: 'books', inStock: true, tags: ['fiction'] },
  2: { name: 'T-Shirt', price: 25, category: 'clothing', inStock: false, tags: ['apparel', 'cotton'] },
  3: { name: 'Headphones', price: 199, category: 'electronics', inStock: true, tags: ['tech', 'audio'] },
  4: { name: 'Cookbook', price: 30, category: 'books', inStock: false, tags: [] },
}

export const CAPACITY = 5

export function makeNumericFieldIndex(field: string): FieldIndex {
  const entries = Object.entries(products)
    .filter(([, doc]) => typeof doc[field] === 'number')
    .map(([id, doc]) => ({ value: doc[field] as number, docId: Number(id) }))
  return {
    type: 'numeric',
    index: {
      eq: (v: number) => new Set(entries.filter(e => e.value === v).map(e => e.docId)),
      gt: (v: number) => new Set(entries.filter(e => e.value > v).map(e => e.docId)),
      gte: (v: number) => new Set(entries.filter(e => e.value >= v).map(e => e.docId)),
      lt: (v: number) => new Set(entries.filter(e => e.value < v).map(e => e.docId)),
      lte: (v: number) => new Set(entries.filter(e => e.value <= v).map(e => e.docId)),
      between: (min: number, max: number) =>
        new Set(entries.filter(e => e.value >= min && e.value <= max).map(e => e.docId)),
      allDocIds: () => new Set(entries.map(e => e.docId)),
      eqBitset: (v: number, cap: number) =>
        bitsetFromSet(new Set(entries.filter(e => e.value === v).map(e => e.docId)), cap),
      gtBitset: (v: number, cap: number) =>
        bitsetFromSet(new Set(entries.filter(e => e.value > v).map(e => e.docId)), cap),
      gteBitset: (v: number, cap: number) =>
        bitsetFromSet(new Set(entries.filter(e => e.value >= v).map(e => e.docId)), cap),
      ltBitset: (v: number, cap: number) =>
        bitsetFromSet(new Set(entries.filter(e => e.value < v).map(e => e.docId)), cap),
      lteBitset: (v: number, cap: number) =>
        bitsetFromSet(new Set(entries.filter(e => e.value <= v).map(e => e.docId)), cap),
      betweenBitset: (min: number, max: number, cap: number) =>
        bitsetFromSet(new Set(entries.filter(e => e.value >= min && e.value <= max).map(e => e.docId)), cap),
      allDocIdsBitset: (cap: number) => bitsetFromSet(new Set(entries.map(e => e.docId)), cap),
    },
  }
}

export function makeBooleanFieldIndex(field: string): FieldIndex {
  const trueDocs: number[] = []
  const falseDocs: number[] = []
  for (const [id, doc] of Object.entries(products)) {
    if (doc[field] === true) trueDocs.push(Number(id))
    else if (doc[field] === false) falseDocs.push(Number(id))
  }
  return {
    type: 'boolean',
    index: {
      getTrue: () => new Set(trueDocs),
      getFalse: () => new Set(falseDocs),
      allDocIds: () => new Set([...trueDocs, ...falseDocs]),
      getTrueBitset: (cap: number) => bitsetFromSet(new Set(trueDocs), cap),
      getFalseBitset: (cap: number) => bitsetFromSet(new Set(falseDocs), cap),
      allDocIdsBitset: (cap: number) => bitsetFromSet(new Set([...trueDocs, ...falseDocs]), cap),
    },
  }
}

export function makeEnumFieldIndex(field: string): FieldIndex {
  const mapping: Record<string, number[]> = {}
  for (const [id, doc] of Object.entries(products)) {
    const val = doc[field]
    if (typeof val === 'string') {
      if (!mapping[val]) mapping[val] = []
      mapping[val].push(Number(id))
    }
  }
  return {
    type: 'enum',
    index: {
      getDocIds: (v: string) => new Set(mapping[v] ?? []),
      allDocIds: () => {
        const all = new Set<number>()
        for (const ids of Object.values(mapping)) {
          for (const id of ids) all.add(id)
        }
        return all
      },
      getDocIdsBitset: (v: string, cap: number) => bitsetFromSet(new Set(mapping[v] ?? []), cap),
      getDocIdsInBitset: (values: string[], cap: number) => {
        const all = new Set<number>()
        for (const val of values) {
          for (const id of mapping[val] ?? []) all.add(id)
        }
        return bitsetFromSet(all, cap)
      },
      allDocIdsBitset: (cap: number) => {
        const all = new Set<number>()
        for (const ids of Object.values(mapping)) {
          for (const id of ids) all.add(id)
        }
        return bitsetFromSet(all, cap)
      },
    },
  }
}

export function buildContext(): FilterContext {
  const allDocIds = new Set([0, 1, 2, 3, 4])
  return {
    fieldIndexes: {
      price: makeNumericFieldIndex('price'),
      inStock: makeBooleanFieldIndex('inStock'),
      category: makeEnumFieldIndex('category'),
    },
    getFieldValue: (id, fieldPath) => products[id]?.[fieldPath],
    allDocIds,
    capacity: CAPACITY,
    allDocIdsBitset: bitsetFromSet(allDocIds, CAPACITY),
  }
}

export function resultSet(expression: FilterExpression, context: FilterContext): Set<number> {
  return bitsetToSet(evaluateFilters(expression, context))
}
