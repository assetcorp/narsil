import { DEFAULT_SPLIT_PATTERN } from '../core/tokenizer/constants'
import { expandNgrams } from '../core/tokenizer/ngrams'
import { foldWidthForms, isAscii, normalizeForSplitting } from '../core/tokenizer/normalize'
import { ErrorCodes, NarsilError } from '../errors'
import type { LanguageModule } from '../types/language'

export interface CharRange {
  start: number
  end: number
}

interface Origins {
  spans: CharRange[]
  next: number
}

function decomposedOrigins(text: string): Map<string, Origins> {
  const origins = new Map<string, Origins>()
  let start = 0
  for (const character of text) {
    const end = start + character.length
    for (const point of foldWidthForms(character).normalize('NFD')) {
      let queue = origins.get(point)
      if (queue === undefined) {
        queue = { spans: [], next: 0 }
        origins.set(point, queue)
      }
      queue.spans.push({ start, end })
    }
    start = end
  }
  return origins
}

function normalizedOrigins(text: string): CharRange[] {
  const origins = decomposedOrigins(text)
  const spans: CharRange[] = []
  let leading: CharRange | null = null
  for (const character of foldWidthForms(text).normalize('NFC')) {
    const span = { start: text.length, end: 0 }
    for (const point of character.normalize('NFD')) {
      const queue = origins.get(point)
      const origin = queue?.spans[queue.next]
      if (queue === undefined || origin === undefined)
        throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The highlight text has inconsistent normalised offsets')
      queue.next++
      span.start = Math.min(span.start, origin.start)
      span.end = Math.max(span.end, origin.end)
    }
    const length = normalizeForSplitting(character).length
    if (length === 0) {
      const previous = spans[spans.length - 1]
      if (previous !== undefined) {
        previous.start = Math.min(previous.start, span.start)
        previous.end = Math.max(previous.end, span.end)
      } else
        leading =
          leading === null ? span : { start: Math.min(leading.start, span.start), end: Math.max(leading.end, span.end) }
      continue
    }
    if (leading !== null) {
      span.start = Math.min(span.start, leading.start)
      span.end = Math.max(span.end, leading.end)
      leading = null
    }
    for (let at = 0; at < length; at++) spans.push(span)
  }
  return spans
}

function tokenOffsets(text: string, language: LanguageModule): CharRange[] {
  const raw = text.split(language.tokenizer?.splitPattern ?? DEFAULT_SPLIT_PATTERN)
  const size = Math.floor(language.tokenizer?.ngramSize ?? 0)
  const spans: CharRange[] = []
  let from = 0
  for (const part of raw) {
    const start = text.indexOf(part, from)
    if (start < 0) {
      spans.push({ start: from, end: from })
      continue
    }
    from = start + part.length
    if (size < 1) {
      spans.push({ start, end: from })
      continue
    }
    const grams: string[] = []
    expandNgrams(part, size, grams)
    let after = 0
    for (const gram of grams) {
      const index = part.indexOf(gram, after)
      if (index < 0) continue
      spans.push({ start: start + index, end: start + index + gram.length })
      after = index + ((part.codePointAt(index) ?? 0) > 0xffff ? 2 : 1)
    }
  }
  return spans
}

export function originalTokenOffsets(text: string, language: LanguageModule): CharRange[] {
  const normalized = normalizeForSplitting(text)
  const tokens = tokenOffsets(normalized, language)
  if (isAscii(text)) return tokens
  const origins = normalizedOrigins(text)
  if (origins.length !== normalized.length)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The highlight text has inconsistent normalised lengths')
  return tokens.map(token => {
    let start = text.length
    let end = 0
    for (let at = token.start; at < token.end; at++) {
      start = Math.min(start, origins[at].start)
      end = Math.max(end, origins[at].end)
    }
    return end === 0 ? { start: 0, end: 0 } : { start, end }
  })
}
