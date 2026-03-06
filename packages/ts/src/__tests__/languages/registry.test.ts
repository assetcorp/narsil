import { describe, it, expect } from 'vitest'
import { registerLanguage, getLanguage, hasLanguage } from '../../languages/registry'
import { english } from '../../languages/english'
import type { LanguageModule } from '../../types/language'

describe('language registry', () => {
  it('has English registered by default', () => {
    expect(hasLanguage('english')).toBe(true)
  })

  it('returns the English module', () => {
    const lang = getLanguage('english')
    expect(lang.name).toBe('english')
    expect(lang.stemmer).toBeTruthy()
    expect(lang.stopWords.size).toBeGreaterThan(0)
  })

  it('returns the same English module instance', () => {
    expect(getLanguage('english')).toBe(english)
  })

  it('throws for unregistered language', () => {
    expect(() => getLanguage('klingon')).toThrow('Language "klingon" is not registered')
  })

  it('throws NarsilError with correct code for unregistered language', () => {
    try {
      getLanguage('elvish')
    } catch (err: unknown) {
      const narsilErr = err as { code: string; details: Record<string, unknown> }
      expect(narsilErr.code).toBe('LANGUAGE_NOT_SUPPORTED')
      expect(narsilErr.details.language).toBe('elvish')
      return
    }
    expect.fail('should have thrown')
  })

  it('reports false for unregistered language', () => {
    expect(hasLanguage('martian')).toBe(false)
  })

  it('registers a custom language', () => {
    const custom: LanguageModule = {
      name: 'pirate',
      stemmer: null,
      stopWords: new Set(['arr', 'ye']),
    }
    registerLanguage(custom)
    expect(hasLanguage('pirate')).toBe(true)
    expect(getLanguage('pirate')).toBe(custom)
  })

  it('allows overwriting a registered language', () => {
    const v1: LanguageModule = {
      name: 'test-lang',
      stemmer: null,
      stopWords: new Set(['v1']),
    }
    const v2: LanguageModule = {
      name: 'test-lang',
      stemmer: (t: string) => t,
      stopWords: new Set(['v2']),
    }
    registerLanguage(v1)
    registerLanguage(v2)
    expect(getLanguage('test-lang')).toBe(v2)
  })
})
