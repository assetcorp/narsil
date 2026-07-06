import { describe, expect, it } from 'vitest'
import { createSurfaceRegistry } from '../../core/surface-registry'

describe('surface registry', () => {
  it('tracks surfaces with their index token and occurrence count', () => {
    const registry = createSurfaceRegistry()
    registry.add('security', 'secur', 3)
    registry.add('security', 'secur', 2)
    registry.add('secure', 'secur', 1)

    const candidates = registry.candidatesForPrefix('secur')
    expect(candidates).toHaveLength(2)
    const security = candidates.find(c => c.surface === 'security')
    expect(security).toEqual({ surface: 'security', token: 'secur', occurrences: 5 })
    expect(registry.size()).toBe(2)
  })

  it('matches candidates by surface prefix only', () => {
    const registry = createSurfaceRegistry()
    registry.add('security', 'secur', 1)
    registry.add('sections', 'section', 1)
    registry.add('running', 'run', 1)

    const surfaces = registry.candidatesForPrefix('sec').map(c => c.surface)
    expect(surfaces.sort()).toEqual(['sections', 'security'])
    expect(registry.candidatesForPrefix('securi').map(c => c.surface)).toEqual(['security'])
    expect(registry.candidatesForPrefix('x')).toEqual([])
    expect(registry.candidatesForPrefix('')).toEqual([])
  })

  it('rejects surfaces equal to their token', () => {
    const registry = createSurfaceRegistry()
    registry.add('fox', 'fox', 3)
    expect(registry.size()).toBe(0)
    expect(registry.candidatesForPrefix('fox')).toEqual([])
    expect(registry.stemChangedTotalFor('fox')).toBe(0)
  })

  it('removes a surface once its count reaches zero', () => {
    const registry = createSurfaceRegistry()
    registry.add('running', 'run', 2)
    registry.subtract('running', 1)
    expect(registry.candidatesForPrefix('runn')).toHaveLength(1)
    registry.subtract('running', 1)
    expect(registry.candidatesForPrefix('runn')).toEqual([])
    expect(registry.size()).toBe(0)
  })

  it('ignores subtraction of unknown surfaces and non-positive amounts', () => {
    const registry = createSurfaceRegistry()
    registry.add('foxes', 'fox', 1)
    registry.subtract('unknown', 5)
    registry.subtract('foxes', 0)
    registry.add('foxes', 'fox', -2)
    expect(registry.candidatesForPrefix('foxe')).toEqual([{ surface: 'foxes', token: 'fox', occurrences: 1 }])
  })

  it('sums stem-changed occurrences per token across mutations', () => {
    const registry = createSurfaceRegistry()
    registry.add('running', 'run', 2)
    registry.add('runs', 'run', 3)
    expect(registry.stemChangedTotalFor('run')).toBe(5)

    registry.add('runner', 'run', 1)
    registry.subtract('runs', 2)
    expect(registry.stemChangedTotalFor('run')).toBe(4)

    registry.subtract('runs', 10)
    expect(registry.stemChangedTotalFor('run')).toBe(3)
    expect(registry.stemChangedTotalFor('walk')).toBe(0)
  })

  it('round-trips through serialize and deserialize', () => {
    const registry = createSurfaceRegistry()
    registry.add('security', 'secur', 4)
    registry.add('foxes', 'fox', 2)

    const serialized = registry.serialize()
    expect(serialized.security).toEqual([4, 'secur'])
    expect(serialized.foxes).toEqual([2, 'fox'])

    const restored = createSurfaceRegistry()
    restored.deserialize(serialized)
    expect(restored.candidatesForPrefix('sec')).toEqual([{ surface: 'security', token: 'secur', occurrences: 4 }])
    expect(restored.candidatesForPrefix('fo')).toEqual([{ surface: 'foxes', token: 'fox', occurrences: 2 }])
    expect(restored.stemChangedTotalFor('secur')).toBe(4)
  })

  it('skips malformed and identity entries during deserialize', () => {
    const registry = createSurfaceRegistry()
    registry.deserialize({
      valid: [2, 'val'],
      identityNumberForm: 3,
      identityTupleForm: [4, 'identityTupleForm'],
      negative: [-1, 'neg'],
      nan: [Number.NaN, 'nan'],
      badShape: ['x', 5] as unknown as [number, string],
    })
    expect(registry.size()).toBe(1)
    expect(registry.candidatesForPrefix('va')).toEqual([{ surface: 'valid', token: 'val', occurrences: 2 }])
  })

  it('clears all entries and buckets', () => {
    const registry = createSurfaceRegistry()
    registry.add('security', 'secur', 1)
    registry.clear()
    expect(registry.size()).toBe(0)
    expect(registry.candidatesForPrefix('sec')).toEqual([])
    expect(registry.stemChangedTotalFor('secur')).toBe(0)
  })
})
