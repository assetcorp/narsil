import { describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'
import { ErrorCodes } from '../../errors'

describe('the address a client takes', () => {
  it('refuses a host and port that carry no scheme', () => {
    expect(() => createNarsilClient({ url: 'localhost:9999' })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
    )
  })

  it('refuses a scheme it cannot send over', () => {
    expect(() => createNarsilClient({ url: 'ftp://example.test' })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
    )
  })

  it('takes an http address, an https address, and a path', () => {
    expect(() => createNarsilClient({ url: 'http://127.0.0.1:7700' })).not.toThrow()
    expect(() => createNarsilClient({ url: 'https://search.example.test' })).not.toThrow()
    expect(() => createNarsilClient({ url: '/search-api' })).not.toThrow()
  })

  it('reads an address that ends in several slashes', () => {
    expect(() => createNarsilClient({ url: 'http://127.0.0.1:7700//' })).not.toThrow()
  })
})
