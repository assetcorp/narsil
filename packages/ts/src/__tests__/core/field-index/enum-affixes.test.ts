import { describe, expect, it } from 'vitest'
import { bitsetToSet } from '../../../core/bitset'
import { createEnumIndex } from '../../../core/field-index'
import { seededRandom } from '../../filters/pattern/random-corpus'

const CAPACITY = 4_000
const PIECES = ['red', 'Red', 'reddish', 'blue', 'ß', 'ss', '😀', 'é', 'é', '', 'a', 'ab', 'abc']

function sorted(ids: Iterable<number>): number[] {
  return [...ids].sort((left, right) => left - right)
}

describe('the prefix and suffix tests of an enum index', () => {
  it('finds exactly the documents whose value starts or ends with the text, through adds, removals, and re-adds', () => {
    const random = seededRandom(91)
    const index = createEnumIndex()
    const stored = new Map<number, string>()
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
    for (let round = 0; round < 40; round++) {
      for (let write = 0; write < 100; write++) {
        const docId = Math.floor(random() * CAPACITY)
        const previous = stored.get(docId)
        if (previous !== undefined) {
          index.remove(docId, previous)
          stored.delete(docId)
        }
        if (random() < 0.7) {
          const value = `${pick(PIECES)}${pick(PIECES)}${random() < 0.1 ? String(round) : ''}`
          index.insert(docId, value)
          stored.set(docId, value)
        }
      }
      for (let probe = 0; probe < 10; probe++) {
        const text = random() < 0.2 ? '' : `${pick(PIECES)}${random() < 0.3 ? pick(PIECES) : ''}`
        const starting = [...stored].filter(([, value]) => value.startsWith(text)).map(([docId]) => docId)
        const ending = [...stored].filter(([, value]) => value.endsWith(text)).map(([docId]) => docId)
        expect(sorted(bitsetToSet(index.queryPrefixBitset(text, CAPACITY))), `starts with ${text}`).toEqual(
          sorted(starting),
        )
        expect(sorted(bitsetToSet(index.querySuffixBitset(text, CAPACITY))), `ends with ${text}`).toEqual(
          sorted(ending),
        )
      }
    }
  })
})
