import { describe, expect, it } from 'vitest'
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

  it('finds no entry where the entry would be the calling module itself', () => {
    expect(resolveWorkerEntry('file:///app/dist/workers/entry.mjs', SOURCE_DIRECTORY, 'workers/entry.mjs')).toBeNull()
  })
})
