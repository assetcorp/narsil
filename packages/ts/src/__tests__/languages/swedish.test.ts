import { describe, expect, it } from 'vitest'
import { swedish } from '../../languages/swedish'

describe('swedish language module', () => {
  describe('stop words', () => {
    it('contains the possessive sitt', () => {
      expect(swedish.stopWords.has('sitt')).toBe(true)
    })

    it('does not contain the content verb sitta', () => {
      expect(swedish.stopWords.has('sitta')).toBe(false)
    })

    it('contains common function words', () => {
      expect(swedish.stopWords.has('och')).toBe(true)
      expect(swedish.stopWords.has('att')).toBe(true)
      expect(swedish.stopWords.has('den')).toBe(true)
    })
  })
})
