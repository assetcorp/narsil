import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'

function loose(config: Record<string, unknown>): NarsilConfig {
  return config as NarsilConfig
}

describe('a configuration that names a setting createNarsil does not take', () => {
  it.each([
    ['a misspelt top-level key', loose({ durabilty: { mode: 'sync' } })],
    ['a misspelt durability key', loose({ durability: { directroy: '/tmp/narsil-typo' } })],
    ['a misspelt worker key', loose({ workers: { enabeld: false } })],
    ['a misspelt lifecycle key', loose({ lifecycle: { idleTimeout: 1_000 } })],
    ['a misspelt analysis key', loose({ analysis: { rebuilds: 'auto' } })],
    ['a plugin with no name', loose({ plugins: [{}] })],
    ['a plugin with an empty name', loose({ plugins: [{ name: ' ' }] })],
  ])('raises CONFIG_INVALID for %s', async (_, config) => {
    await expect(createNarsil(config)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('starts an engine whose settings are all known', async () => {
    const engine = await createNarsil({ workers: { enabled: false }, plugins: [{ name: 'audit' }] })
    await engine.shutdown()
  })
})
