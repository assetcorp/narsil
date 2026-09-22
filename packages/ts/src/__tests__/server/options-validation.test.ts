import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { createServer, isNarsilError, NarsilError } from '../../server'

describe('what createServer accepts', () => {
  let engine: Narsil

  beforeEach(async () => {
    engine = await createNarsil({ workers: { enabled: false } })
  })

  afterEach(async () => {
    await engine.shutdown()
  })

  it('refuses an options object passed where the engine belongs', () => {
    const optionsAsEngine = { port: 0 } as unknown as Narsil

    expect(() => createServer(optionsAsEngine)).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
    )
  })

  it('refuses a body cap that is not a whole number', () => {
    expect(() => createServer(engine, { limits: { maxBodyBytes: Number.NaN } })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
    )
    expect(() => createServer(engine, { limits: { maxResultWindow: -5 } })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
    )
  })

  it('accepts the values that mean no bound', () => {
    expect(() => createServer(engine, { limits: { maxConcurrentRequests: 0, maxConcurrentTasks: 0 } })).not.toThrow()
  })

  it('exports the error class and the guard from the server entry', () => {
    expect(isNarsilError(new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'gone'))).toBe(true)
  })
})
