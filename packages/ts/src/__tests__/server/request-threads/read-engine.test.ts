import { describe, expect, it } from 'vitest'
import { DEFAULT_PATTERN_WORK_CAP } from '../../../core/pattern-index/constants'
import { createThreadReadEngine } from '../../../server/request-threads/read-engine'
import type { RelayClient } from '../../../server/request-threads/relay-client'
import type { DirectExecutorExtensions, IndexQueryContext } from '../../../workers/direct-executor'

const SCHEMA = { title: 'string', embedding: 'vector[4]' } as const

function threadWithoutHeldVectors() {
  const context = {
    config: { schema: SCHEMA },
    vectorSearchers: new Map(),
    analysisStale: false,
  } as unknown as IndexQueryContext
  const executor = {
    queryContextOf: () => context,
    holdsVectorField: () => false,
  } as unknown as DirectExecutorExtensions
  return createThreadReadEngine({
    executor,
    relay: {} as RelayClient,
    searchHooks: false,
    patternWorkCap: DEFAULT_PATTERN_WORK_CAP,
  })
}

describe('a request thread holding an index whose vector field it lacks', () => {
  it('counts the matches itself while it sends a search answering with documents to the main thread', () => {
    const local = threadWithoutHeldVectors()

    expect(local.canAnswer('catalogue', { term: 'bicycle' })).toBe(false)
    expect(local.canAnswer('catalogue', { term: 'bicycle', document: false })).toBe(true)
    expect(local.canCount('catalogue', { term: 'bicycle' })).toBe(true)
  })
})
