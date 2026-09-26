import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNarsil } from '../../narsil'
import { resolveWorkerEntry } from '../../workers/entry-point'

const SOURCE_DIRECTORY = /\/src\/workers\/[^/]+$/

describe('the worker entry that an engine spawns', () => {
  it('points a published build at the entry beside it', () => {
    expect(
      resolveWorkerEntry(
        'file:///app/node_modules/@delali/narsil/dist/chunk-a1.mjs',
        SOURCE_DIRECTORY,
        'workers/entry.mjs',
      ),
    ).toBe('file:///app/node_modules/@delali/narsil/dist/workers/entry.mjs')
  })

  it('points a source checkout at the built entry', () => {
    expect(resolveWorkerEntry('file:///repo/src/workers/factory.ts', SOURCE_DIRECTORY, 'workers/entry.mjs')).toBe(
      'file:///repo/dist/workers/entry.mjs',
    )
  })

  it('finds no entry for an application bundle, so no worker loads the application itself', () => {
    expect(resolveWorkerEntry('file:///app/server.mjs', SOURCE_DIRECTORY, 'workers/entry.mjs')).toBeNull()
  })
})

describe('the search backend settings an engine checks as it starts', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses to start where NARSIL_REQUIRE_NATIVE_CORE is 1 and no core loads', async () => {
    vi.stubEnv('NARSIL_REQUIRE_NATIVE_CORE', '1')
    vi.stubEnv('NARSIL_NATIVE_CORE_PATH', '/nonexistent/narsil-core.node')

    await expect(createNarsil({ workers: { enabled: false } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('refuses to start where NARSIL_SEARCH_BACKEND names no backend', async () => {
    vi.stubEnv('NARSIL_SEARCH_BACKEND', 'gpu')

    await expect(createNarsil({ workers: { enabled: false } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })
})
