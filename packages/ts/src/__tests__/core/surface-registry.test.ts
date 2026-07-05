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
    registry.add('section', 'section', 1)
    registry.add('running', 'run', 1)

    const surfaces = registry.candidatesForPrefix('sec').map(c => c.surface)
    expect(surfaces.sort()).toEqual(['section', 'security'])
    expect(registry.candidatesForPrefix('securi').map(c => c.surface)).toEqual(['security'])
    expect(registry.candidatesForPrefix('x')).toEqual([])
    expect(registry.candidatesForPrefix('')).toEqual([])
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
    registry.add('fox', 'fox', 1)
    registry.subtract('unknown', 5)
    registry.subtract('fox', 0)
    registry.add('fox', 'fox', -2)
    expect(registry.candidatesForPrefix('fox')).toEqual([{ surface: 'fox', token: 'fox', occurrences: 1 }])
  })

  it('round-trips through serialize and deserialize', () => {
    const registry = createSurfaceRegistry()
    registry.add('security', 'secur', 4)
    registry.add('fox', 'fox', 2)

    const serialized = registry.serialize()
    expect(serialized.security).toEqual([4, 'secur'])
    expect(serialized.fox).toBe(2)

    const restored = createSurfaceRegistry()
    restored.deserialize(serialized)
    expect(restored.candidatesForPrefix('sec')).toEqual([{ surface: 'security', token: 'secur', occurrences: 4 }])
    expect(restored.candidatesForPrefix('fo')).toEqual([{ surface: 'fox', token: 'fox', occurrences: 2 }])
  })

  it('skips malformed entries during deserialize', () => {
    const registry = createSurfaceRegistry()
    registry.deserialize({
      valid: 3,
      alsoValid: [2, 'also'],
      negative: -1,
      nan: Number.NaN,
      badShape: ['x', 5] as unknown as [number, string],
    })
    expect(registry.size()).toBe(2)
    expect(registry.candidatesForPrefix('va')).toEqual([{ surface: 'valid', token: 'valid', occurrences: 3 }])
  })

  it('clears all entries and buckets', () => {
    const registry = createSurfaceRegistry()
    registry.add('security', 'secur', 1)
    registry.clear()
    expect(registry.size()).toBe(0)
    expect(registry.candidatesForPrefix('sec')).toEqual([])
  })
})
