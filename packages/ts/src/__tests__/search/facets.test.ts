import { describe, expect, it } from 'vitest'
import { mergeFacets } from '../../search/facets'
import type { FacetResult } from '../../types/results'

describe('mergeFacets', () => {
  describe('overlapping values across partitions', () => {
    it('sums counts for the same value across three partitions', () => {
      const partition1: Record<string, FacetResult> = {
        category: { values: { electronics: 5, clothing: 3 }, count: 2 },
      }
      const partition2: Record<string, FacetResult> = {
        category: { values: { electronics: 2, food: 4 }, count: 2 },
      }
      const partition3: Record<string, FacetResult> = {
        category: { values: { electronics: 1, clothing: 2, food: 1 }, count: 3 },
      }

      const result = mergeFacets([partition1, partition2, partition3])

      expect(result.category.values.electronics).toBe(8)
      expect(result.category.values.clothing).toBe(5)
      expect(result.category.values.food).toBe(5)
      expect(result.category.count).toBe(3)
    })
  })

  describe('disjoint values', () => {
    it('preserves all values when partitions have no overlap', () => {
      const partition1: Record<string, FacetResult> = {
        color: { values: { red: 3 }, count: 1 },
      }
      const partition2: Record<string, FacetResult> = {
        color: { values: { blue: 5 }, count: 1 },
      }

      const result = mergeFacets([partition1, partition2])

      expect(result.color.values.red).toBe(3)
      expect(result.color.values.blue).toBe(5)
      expect(result.color.count).toBe(2)
    })
  })

  describe('empty partitions', () => {
    it('returns an empty result when all partitions are empty', () => {
      const result = mergeFacets([{}, {}, {}])
      expect(Object.keys(result)).toHaveLength(0)
    })

    it('handles an empty partitions array', () => {
      const result = mergeFacets([])
      expect(Object.keys(result)).toHaveLength(0)
    })

    it('skips empty partitions while merging non-empty ones', () => {
      const partition1: Record<string, FacetResult> = {
        size: { values: { small: 2, large: 5 }, count: 2 },
      }

      const result = mergeFacets([{}, partition1, {}])

      expect(result.size.values.small).toBe(2)
      expect(result.size.values.large).toBe(5)
      expect(result.size.count).toBe(2)
    })
  })

  describe('single partition passthrough', () => {
    it('returns the same facet data when given a single partition', () => {
      const partition: Record<string, FacetResult> = {
        brand: { values: { nike: 10, adidas: 8 }, count: 2 },
        color: { values: { white: 3 }, count: 1 },
      }

      const result = mergeFacets([partition])

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
        category: { values: { books: 3 }, count: 1 },
        format: { values: { hardcover: 2 }, count: 1 },
      }
      const partition2: Record<string, FacetResult> = {
        category: { values: { books: 1, games: 4 }, count: 2 },
        format: { values: { paperback: 5 }, count: 1 },
      }

      const result = mergeFacets([partition1, partition2])

      expect(result.category.values.books).toBe(4)
      expect(result.category.values.games).toBe(4)
      expect(result.category.count).toBe(2)
      expect(result.format.values.hardcover).toBe(2)
      expect(result.format.values.paperback).toBe(5)
      expect(result.format.count).toBe(2)
    })
  })
})
