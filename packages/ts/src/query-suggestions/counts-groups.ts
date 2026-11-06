import { MAX_MAX_LENGTH, MAX_MAX_WORDS, MAX_PEOPLE_PER_PHRASE_IN_FILE, SCRAMBLED_ID_BYTES } from './constants'
import { MalformedPayload, type StrictReader } from './msgpack-cursor'
import { isGroup, isNormalPhrase, type PhraseLimits } from './phrase'

export interface CountsPeople {
  readonly source: Uint8Array
  readonly offsets: readonly number[]
}

export type PhraseVisitor = (group: string, phrase: string, count: number, people: CountsPeople) => void

const FILE_LIMITS: PhraseLimits = {
  minLetters: 1,
  maxLength: MAX_MAX_LENGTH,
  maxWords: MAX_MAX_WORDS,
  maxDigits: MAX_MAX_LENGTH,
}
const KEY_PHRASE = 'phrase'
const KEY_COUNT = 'count'
const KEY_PEOPLE = 'people'
const MAX_UINT32 = 0xffffffff

function readPeople(reader: StrictReader): number[] {
  const people = reader.array()
  if (people > MAX_PEOPLE_PER_PHRASE_IN_FILE) throw new MalformedPayload('A phrase lists too many people')
  const offsets: number[] = []
  for (let i = 0; i < people; i++) {
    const { offset, length } = reader.binary()
    if (length !== SCRAMBLED_ID_BYTES) throw new MalformedPayload('A scrambled ID has the wrong length')
    offsets.push(offset)
  }
  return offsets
}

export function walkGroups(
  reader: StrictReader,
  payload: Uint8Array,
  visitor: PhraseVisitor | null,
  onGroup: ((group: string) => void) | null = null,
): void {
  const groupCount = reader.map()
  const validating = visitor === null && onGroup === null
  const seenGroups = validating ? new Set<string>() : null
  for (let g = 0; g < groupCount; g++) {
    const group = reader.string()
    onGroup?.(group)
    if (seenGroups !== null) {
      if (!isGroup(group) || seenGroups.has(group)) throw new MalformedPayload('A group is invalid or repeated')
      seenGroups.add(group)
    }
    const phraseCount = reader.array()
    const seenPhrases = validating ? new Set<string>() : null
    for (let p = 0; p < phraseCount; p++) {
      const fields = reader.map()
      let phrase: string | null = null
      let count: number | null = null
      let offsets: number[] | null = null
      for (let f = 0; f < fields; f++) {
        const key = reader.string()
        if (key === KEY_PHRASE && phrase === null) phrase = reader.string()
        else if (key === KEY_COUNT && count === null) count = reader.uint()
        else if (key === KEY_PEOPLE && offsets === null) offsets = readPeople(reader)
        else throw new MalformedPayload(`A phrase holds an unexpected or repeated key "${key}"`)
      }
      if (phrase === null || count === null || offsets === null) throw new MalformedPayload('A phrase lacks a key')
      if (seenPhrases !== null) {
        if (!isNormalPhrase(phrase, FILE_LIMITS) || seenPhrases.has(phrase)) {
          throw new MalformedPayload('A phrase is invalid or repeated')
        }
        if (offsets.length > count || count > MAX_UINT32) {
          throw new MalformedPayload('A phrase lists more people than its count')
        }
        seenPhrases.add(phrase)
      }
      visitor?.(group, phrase, count, { source: payload, offsets })
    }
  }
}
