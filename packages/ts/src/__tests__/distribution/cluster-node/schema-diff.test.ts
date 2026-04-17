import { describe, expect, it } from 'vitest'
import { diffSchemas } from '../../../distribution/cluster-node/schema-diff'
import type { SchemaDefinition } from '../../../types/schema'

describe('diffSchemas', () => {
  it('returns an empty diff when both schemas match', () => {
    const a: SchemaDefinition = { title: 'text', price: 'number' } as unknown as SchemaDefinition
    const b: SchemaDefinition = { title: 'text', price: 'number' } as unknown as SchemaDefinition
    expect(diffSchemas(a, b)).toEqual([])
  })

  it('reports a missing field in actual', () => {
    const expected: SchemaDefinition = { title: 'text', price: 'number' } as unknown as SchemaDefinition
    const actual: SchemaDefinition = { title: 'text' } as unknown as SchemaDefinition
    const diffs = diffSchemas(expected, actual)
    expect(diffs).toEqual([{ path: 'price', expected: 'number', actual: '(absent)' }])
  })

  it('reports an extra field in actual', () => {
    const expected: SchemaDefinition = { title: 'text' } as unknown as SchemaDefinition
    const actual: SchemaDefinition = { title: 'text', bogus: 'boolean' } as unknown as SchemaDefinition
    const diffs = diffSchemas(expected, actual)
    expect(diffs).toEqual([{ path: 'bogus', expected: '(absent)', actual: 'boolean' }])
  })

  it('walks nested objects to report diffs on leaf paths', () => {
    const expected: SchemaDefinition = {
      author: { name: 'text' },
    } as unknown as SchemaDefinition
    const actual: SchemaDefinition = {
      author: { name: 'text', title: 'text' },
    } as unknown as SchemaDefinition
    const diffs = diffSchemas(expected, actual)
    expect(diffs).toEqual([{ path: 'author.title', expected: '(absent)', actual: 'text' }])
  })

  it('L-new-1: stops recursing at the maximum nesting depth and emits a depth-exceeded sentinel', () => {
    const makeDeep = (depth: number): SchemaDefinition => {
      let inner: Record<string, unknown> = { leaf: 'text' }
      for (let i = 0; i < depth; i++) {
        inner = { [`l${depth - i}`]: inner }
      }
      return inner as unknown as SchemaDefinition
    }

    // Five nesting levels beyond the root object: l5 -> l4 -> l3 -> l2 -> l1 -> leaf.
    // The walk starts at depth 1 on the root and enters each nested object at
    // depth + 1; depth reaches 5 while descending into the fourth level, which
    // exceeds the cap of 4.
    const deep = makeDeep(5)

    let diffs: ReturnType<typeof diffSchemas> = []
    expect(() => {
      diffs = diffSchemas(deep, deep)
    }).not.toThrow()

    expect(diffs.length).toBeGreaterThan(0)
    expect(diffs.some(d => d.expected === 'depth-exceeded' && d.actual === 'depth-exceeded')).toBe(true)
  })

  it('L-new-1: guards against cyclic schemas without stack-overflowing', () => {
    const self: Record<string, unknown> = { name: 'text' }
    self.child = self
    const other: Record<string, unknown> = { name: 'text' }
    other.child = other

    let diffs: ReturnType<typeof diffSchemas> = []
    expect(() => {
      diffs = diffSchemas(self as unknown as SchemaDefinition, other as unknown as SchemaDefinition)
    }).not.toThrow()
    expect(diffs.some(d => d.expected === 'depth-exceeded')).toBe(true)
  })
})
