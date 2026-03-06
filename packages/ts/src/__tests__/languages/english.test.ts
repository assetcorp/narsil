import { describe, expect, it } from 'vitest'
import { english } from '../../languages/english'

describe('english language module', () => {
  it('has the correct name', () => {
    expect(english.name).toBe('english')
  })

  it('provides a stemmer function', () => {
    expect(typeof english.stemmer).toBe('function')
  })

  it('provides a non-empty stop words set', () => {
    expect(english.stopWords.size).toBeGreaterThan(100)
  })

  describe('stemmer', () => {
    const stem = english.stemmer!

    it('returns short words unchanged', () => {
      expect(stem('a')).toBe('a')
      expect(stem('be')).toBe('be')
    })

    it('strips -s plurals', () => {
      expect(stem('cats')).toBe('cat')
      expect(stem('dogs')).toBe('dog')
    })

    it('strips -es plurals', () => {
      expect(stem('caresses')).toBe('caress')
      expect(stem('ponies')).toBe('poni')
    })

    it('keeps -ss endings', () => {
      expect(stem('caress')).toBe('caress')
    })

    it('handles -eed suffix', () => {
      expect(stem('agreed')).toBe('agre')
      expect(stem('feed')).toBe('feed')
    })

    it('handles -ed suffix', () => {
      expect(stem('plastered')).toBe('plaster')
      expect(stem('bled')).toBe('bled')
    })

    it('handles -ing suffix', () => {
      expect(stem('motoring')).toBe('motor')
      expect(stem('sing')).toBe('sing')
    })

    it('handles -ational to -ate', () => {
      expect(stem('relational')).toBe('relat')
    })

    it('handles -ization to -ize', () => {
      expect(stem('visualization')).toBe('visual')
    })

    it('handles -fulness to -ful', () => {
      expect(stem('hopefulness')).toBe('hope')
    })

    it('handles trailing -y to -i', () => {
      expect(stem('happy')).toBe('happi')
    })

    it('handles words starting with y', () => {
      expect(stem('yield')).toBe('yield')
    })

    it('handles -ical to -ic', () => {
      expect(stem('electrical')).toBe('electr')
    })

    it('handles -ive removal', () => {
      expect(stem('effective')).toBe('effect')
    })

    it('handles double-l collapse', () => {
      expect(stem('controll')).toBe('control')
      expect(stem('roll')).toBe('roll')
    })

    it('produces consistent stems for word families', () => {
      const connectStems = [stem('connect'), stem('connected'), stem('connecting'), stem('connection')]
      expect(new Set(connectStems).size).toBe(1)
    })

    it('produces consistent stems for generalize family', () => {
      expect(stem('generalize')).toBe(stem('generalization'))
    })
  })

  describe('stop words', () => {
    it('contains common articles', () => {
      expect(english.stopWords.has('a')).toBe(true)
      expect(english.stopWords.has('an')).toBe(true)
      expect(english.stopWords.has('the')).toBe(true)
    })

    it('contains common pronouns', () => {
      expect(english.stopWords.has('i')).toBe(true)
      expect(english.stopWords.has('you')).toBe(true)
      expect(english.stopWords.has('he')).toBe(true)
      expect(english.stopWords.has('she')).toBe(true)
      expect(english.stopWords.has('it')).toBe(true)
      expect(english.stopWords.has('we')).toBe(true)
      expect(english.stopWords.has('they')).toBe(true)
    })

    it('contains common prepositions', () => {
      expect(english.stopWords.has('in')).toBe(true)
      expect(english.stopWords.has('on')).toBe(true)
      expect(english.stopWords.has('at')).toBe(true)
      expect(english.stopWords.has('to')).toBe(true)
      expect(english.stopWords.has('for')).toBe(true)
    })

    it('contains contractions', () => {
      expect(english.stopWords.has("i'm")).toBe(true)
      expect(english.stopWords.has("don't")).toBe(true)
      expect(english.stopWords.has("won't")).toBe(true)
      expect(english.stopWords.has("can't")).toBe(true)
    })

    it('does not contain content words', () => {
      expect(english.stopWords.has('search')).toBe(false)
      expect(english.stopWords.has('computer')).toBe(false)
      expect(english.stopWords.has('language')).toBe(false)
    })
  })
})
