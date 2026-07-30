import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fixturesByLanguage, languageFixtures } from './fixtures'

const languagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../languages')

const NON_LANGUAGE_MODULES = new Set(['registry'])

function shippedLanguageNames(): string[] {
  return readdirSync(languagesDir)
    .filter(entry => entry.endsWith('.ts'))
    .map(entry => entry.slice(0, -3))
    .filter(name => !NON_LANGUAGE_MODULES.has(name))
    .sort()
}

describe('every shipped language has a verification fixture', () => {
  const shipped = shippedLanguageNames()

  it('finds language modules on disk', () => {
    expect(shipped.length).toBeGreaterThan(0)
  })

  for (const name of shipped) {
    it(`${name} has a fixture`, () => {
      expect(fixturesByLanguage.has(name)).toBe(true)
    })
  }

  it('has no fixture for a language that does not ship', () => {
    const orphans = [...fixturesByLanguage.keys()].filter(name => !shipped.includes(name))
    expect(orphans).toEqual([])
  })

  it('names every fixture after the module it covers', () => {
    const mismatched = languageFixtures
      .filter(fixture => !shipped.includes(fixture.module.name))
      .map(fixture => fixture.module.name)
    expect(mismatched).toEqual([])
  })
})

describe('every fixture carries enough evidence to be worth running', () => {
  for (const fixture of languageFixtures) {
    describe(fixture.module.name, () => {
      it('quotes at least two published samples', () => {
        expect(fixture.samples.length).toBeGreaterThanOrEqual(2)
      })

      it('cites a source for every sample', () => {
        const unsourced = fixture.samples.filter(sample => sample.source.trim().length === 0).map(sample => sample.text)
        expect(unsourced).toEqual([])
      })

      it('names words that must survive as one token', () => {
        expect(fixture.indivisible.length).toBeGreaterThan(0)
      })

      it('names text that must split into several tokens', () => {
        expect(fixture.separates.length).toBeGreaterThan(0)
      })

      it('names a query that must retrieve a document', () => {
        expect(fixture.retrievable.length).toBeGreaterThan(0)
      })
    })
  }
})
