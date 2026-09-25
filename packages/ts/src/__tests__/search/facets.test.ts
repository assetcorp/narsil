import { describe, expect, it } from 'vitest'
import { everyValueFacetConfig, mergeFacets, oversampledFacetConfig } from '../../search/facets'
import type { FacetResult } from '../../types/results'

describe('mergeFacets', () => {
  describe('overlapping values across partitions', () => {
    it('sums counts for the same value across three partitions', () => {
      const partition1: Record<string, FacetResult> = {
        category: { values: { electronics: 5, clothing: 3 }, count: 2, errorBound: 0 },
      }
      const partition2: Record<string, FacetResult> = {
        category: { values: { electronics: 2, food: 4 }, count: 2, errorBound: 0 },
      }
      const partition3: Record<string, FacetResult> = {
        category: { values: { electronics: 1, clothing: 2, food: 1 }, count: 3, errorBound: 0 },
      }

      const result = mergeFacets([partition1, partition2, partition3], {})

      expect(result.category.values.electronics).toBe(8)
      expect(result.category.values.clothing).toBe(5)
      expect(result.category.values.food).toBe(5)
      expect(result.category.count).toBe(3)
    })
  })

  describe('disjoint values', () => {
    it('preserves all values when partitions have no overlap', () => {
      const partition1: Record<string, FacetResult> = {
        color: { values: { red: 3 }, count: 1, errorBound: 0 },
      }
      const partition2: Record<string, FacetResult> = {
        color: { values: { blue: 5 }, count: 1, errorBound: 0 },
      }

      const result = mergeFacets([partition1, partition2], {})

      expect(result.color.values.red).toBe(3)
      expect(result.color.values.blue).toBe(5)
      expect(result.color.count).toBe(2)
    })
  })

  describe('empty partitions', () => {
    it('returns an empty result when all partitions are empty', () => {
      const result = mergeFacets([{}, {}, {}], {})
      expect(Object.keys(result)).toHaveLength(0)
    })

    it('handles an empty partitions array', () => {
      const result = mergeFacets([], {})
      expect(Object.keys(result)).toHaveLength(0)
    })

    it('skips empty partitions while merging non-empty ones', () => {
      const partition1: Record<string, FacetResult> = {
        size: { values: { small: 2, large: 5 }, count: 2, errorBound: 0 },
      }

      const result = mergeFacets([{}, partition1, {}], {})

      expect(result.size.values.small).toBe(2)
      expect(result.size.values.large).toBe(5)
      expect(result.size.count).toBe(2)
    })
  })

  describe('single partition passthrough', () => {
    it('returns the same facet data when given a single partition', () => {
      const partition: Record<string, FacetResult> = {
        brand: { values: { nike: 10, adidas: 8 }, count: 2, errorBound: 0 },
        color: { values: { white: 3 }, count: 1, errorBound: 0 },
      }

      const result = mergeFacets([partition], {})

      expect(result.brand.values.nike).toBe(10)
      expect(result.brand.values.adidas).toBe(8)
      expect(result.brand.count).toBe(2)
      expect(result.color.values.white).toBe(3)
      expect(result.color.count).toBe(1)
    })
  })

  describe('multiple facet fields', () => {
    it('merges each field independently', () => {
      const partition1: Record<string, FacetResult> = {
        category: { values: { books: 3 }, count: 1, errorBound: 0 },
        format: { values: { hardcover: 2 }, count: 1, errorBound: 0 },
      }
      const partition2: Record<string, FacetResult> = {
        category: { values: { books: 1, games: 4 }, count: 2, errorBound: 0 },
        format: { values: { paperback: 5 }, count: 1, errorBound: 0 },
      }

      const result = mergeFacets([partition1, partition2], {})

      expect(result.category.values.books).toBe(4)
      expect(result.category.values.games).toBe(4)
      expect(result.category.count).toBe(2)
      expect(result.format.values.hardcover).toBe(2)
      expect(result.format.values.paperback).toBe(5)
      expect(result.format.count).toBe(2)
    })
  })

  describe('error bounds', () => {
    it('adds up what each partition left out, because each undercounts on its own', () => {
      const partition1: Record<string, FacetResult> = {
        category: { values: { books: 3 }, count: 1, errorBound: 4 },
      }
      const partition2: Record<string, FacetResult> = {
        category: { values: { books: 1 }, count: 1, errorBound: 7 },
      }

      const result = mergeFacets([partition1, partition2], {})

      expect(result.category.errorBound).toBe(11)
    })

    it('reports an exact merge as 0 where no partition dropped a value', () => {
      const partition: Record<string, FacetResult> = {
        colour: { values: { red: 2 }, count: 1, errorBound: 0 },
      }

      expect(mergeFacets([partition], {}).colour.errorBound).toBe(0)
    })
  })

  describe('cutting each field to its limit', () => {
    const partitions: Array<Record<string, FacetResult>> = [
      { brand: { values: { acme: 5, globex: 4, initech: 1 }, count: 3, errorBound: 0 } },
      { brand: { values: { acme: 1, globex: 1, initech: 6, umbrella: 2 }, count: 4, errorBound: 0 } },
      { brand: { values: { hooli: 3, initech: 2 }, count: 2, errorBound: 0 } },
    ]

    it('returns the limit, ordered by the summed counts, where each partition sent every value', () => {
      const result = mergeFacets(partitions, { brand: { limit: 2 } })

      expect(result.brand.values).toEqual({ initech: 9, acme: 6 })
      expect(Object.keys(result.brand.values)).toEqual(['initech', 'acme'])
      expect(result.brand.count).toBe(2)
      expect(result.brand.errorBound).toBe(5)
    })

    it('keeps the lowest counts first under an ascending sort', () => {
      const result = mergeFacets(partitions, { brand: { limit: 2, sort: 'asc' } })

      expect(Object.keys(result.brand.values)).toEqual(['umbrella', 'hooli'])
      expect(result.brand.errorBound).toBe(9)
    })

    it('treats a fractional limit as the whole number below it', () => {
      const result = mergeFacets(partitions, { brand: { limit: 2.9 } })

      expect(result.brand.count).toBe(2)
    })

    it('keeps the summed partition bounds where they exceed the largest count it drops', () => {
      const bounded: Array<Record<string, FacetResult>> = [
        { tag: { values: { a: 9, b: 1 }, count: 2, errorBound: 6 } },
        { tag: { values: { a: 2, c: 1 }, count: 2, errorBound: 5 } },
      ]

      expect(mergeFacets(bounded, { tag: { limit: 1 } }).tag.errorBound).toBe(11)
    })
  })
})

describe('everyValueFacetConfig', () => {
  it('drops every field limit and keeps each sort and range', () => {
    const ranges = [{ from: 0, to: 10 }]
    const widened = everyValueFacetConfig({ brand: { limit: 3, sort: 'asc' }, price: { limit: 2, ranges } })

    expect(widened.brand).toEqual({ limit: undefined, sort: 'asc' })
    expect(widened.price).toEqual({ limit: undefined, ranges })
  })
})

describe('oversampledFacetConfig', () => {
  it('asks each worker for half again the limit plus ten, the cluster oversample', () => {
    const widened = oversampledFacetConfig({ brand: { limit: 10 }, colour: { limit: 3 }, size: {} })

    expect(widened.brand.limit).toBe(25)
    expect(widened.colour.limit).toBe(15)
    expect(widened.size.limit).toBeUndefined()
  })
})
