import { describe, expect, it } from 'vitest'
import type { LanguageModule } from '../../types/language'
import { languageFixtures } from './fixtures'

function classBody(pattern: RegExp): string {
  const match = /^\[\^([\s\S]*)\][*+?]?$/.exec(pattern.source)
  return match ? match[1] : ''
}

function listedCharacters(body: string): string[] {
  const listed: string[] = []
  const units: Array<{ char: string; literal: boolean }> = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char !== '\\') {
      units.push({ char, literal: true })
      continue
    }
    const next = body[i + 1] ?? ''
    if (next === 'u') {
      const braced = /^\\u\{([0-9A-Fa-f]+)\}/.exec(body.slice(i))
      const plain = /^\\u([0-9A-Fa-f]{4})/.exec(body.slice(i))
      const hex = braced ?? plain
      if (hex) {
        units.push({ char: String.fromCodePoint(Number.parseInt(hex[1], 16)), literal: false })
        i += hex[0].length - 1
        continue
      }
    }
    if (next === 'p' || next === 'P') {
      const property = /^\\[pP]\{[^}]*\}/.exec(body.slice(i))
      if (property) {
        i += property[0].length - 1
        continue
      }
    }
    units.push({ char: next, literal: false })
    i++
  }

  for (let i = 0; i < units.length; i++) {
    const isRange = units[i + 1]?.char === '-' && units[i + 1]?.literal && i + 2 < units.length
    if (isRange) {
      i += 2
      continue
    }
    const { char } = units[i]
    if (char.codePointAt(0) !== undefined && char.charCodeAt(0) > 127) listed.push(char)
  }

  return [...new Set(listed)]
}

function specialLetters(module: LanguageModule): string[] {
  const pattern = module.tokenizer?.splitPattern
  if (!pattern) return []
  return listedCharacters(classBody(pattern))
}

describe('every character a language claims to support appears in its published samples', () => {
  for (const fixture of languageFixtures) {
    const letters = specialLetters(fixture.module)
    if (letters.length === 0) continue

    it(`${fixture.module.name} exercises each of its own special letters`, () => {
      const written = fixture.samples
        .map(sample => sample.text)
        .concat(fixture.indivisible)
        .concat(fixture.separates.map(entry => entry.text))
        .concat(fixture.retrievable.flatMap(entry => [entry.query, entry.text]))
        .concat([...fixture.module.stopWords])
        .join(' ')
        .normalize('NFC')
      const seen = new Set([...written, ...written.toLowerCase(), ...written.toUpperCase()])
      const untested = letters.filter(letter => !seen.has(letter))
      expect(untested).toEqual([])
    })
  }
})
