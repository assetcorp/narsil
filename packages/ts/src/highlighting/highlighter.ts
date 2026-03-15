import { tokenize } from '../core/tokenizer'
import type { LanguageModule } from '../types/language'
import type { HighlightMatch } from '../types/results'

export interface HighlightOptions {
  preTag?: string
  postTag?: string
  maxSnippetLength?: number
}

interface CharRange {
  start: number
  end: number
}

function buildTokenCharOffsets(text: string, originalTokens: string[]): CharRange[] {
  const offsets: CharRange[] = []
  let searchFrom = 0

  for (const token of originalTokens) {
    const idx = text.indexOf(token, searchFrom)
    if (idx === -1) continue
    offsets.push({ start: idx, end: idx + token.length })
    searchFrom = idx + token.length
  }

  return offsets
}

function mergeOverlapping(ranges: CharRange[]): CharRange[] {
  if (ranges.length === 0) return []

  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: CharRange[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = sorted[i]
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end)
    } else {
      merged.push(curr)
    }
  }

  return merged
}

function findDensestWindow(positions: CharRange[], text: string, windowSize: number): { start: number; end: number } {
  if (positions.length === 0) {
    return { start: 0, end: Math.min(windowSize, text.length) }
  }

  let bestStart = 0
  let bestCount = 0

  for (const pos of positions) {
    const windowStart = Math.max(0, pos.start - Math.floor(windowSize / 2))
    const windowEnd = Math.min(text.length, windowStart + windowSize)
    const adjustedStart = Math.max(0, windowEnd - windowSize)

    let count = 0
    for (const p of positions) {
      if (p.start >= adjustedStart && p.end <= windowEnd) {
        count++
      }
    }

    if (count > bestCount) {
      bestCount = count
      bestStart = adjustedStart
    }
  }

  return { start: bestStart, end: Math.min(text.length, bestStart + windowSize) }
}

function applySnippetTruncation(
  taggedText: string,
  originalText: string,
  positions: CharRange[],
  maxLen: number,
  preTag: string,
  postTag: string,
): { snippet: string; adjustedPositions: CharRange[] } {
  if (maxLen <= 0 || originalText.length <= maxLen) {
    return { snippet: taggedText, adjustedPositions: positions }
  }

  const window = findDensestWindow(positions, originalText, maxLen)
  const snippetRaw = originalText.substring(window.start, window.end)

  const adjustedPositions: CharRange[] = []
  for (const pos of positions) {
    if (pos.start >= window.start && pos.end <= window.end) {
      adjustedPositions.push({
        start: pos.start - window.start,
        end: pos.end - window.start,
      })
    }
  }

  let snippet = snippetRaw
  const sortedDesc = [...adjustedPositions].sort((a, b) => b.start - a.start)
  for (const pos of sortedDesc) {
    snippet =
      snippet.substring(0, pos.start) +
      preTag +
      snippet.substring(pos.start, pos.end) +
      postTag +
      snippet.substring(pos.end)
  }

  const needsLeadingEllipsis = window.start > 0
  const needsTrailingEllipsis = window.end < originalText.length

  if (needsLeadingEllipsis) snippet = `...${snippet}`
  if (needsTrailingEllipsis) snippet = `${snippet}...`

  return { snippet, adjustedPositions }
}

export function highlightField(
  text: string,
  queryTokens: Array<{ token: string; position: number }>,
  language: LanguageModule,
  options?: HighlightOptions,
): HighlightMatch {
  const preTag = options?.preTag ?? '<mark>'
  const postTag = options?.postTag ?? '</mark>'
  const maxSnippetLength = options?.maxSnippetLength ?? 200

  if (text.length === 0) {
    return { snippet: text, positions: [] }
  }

  const fieldResult = tokenize(text, language, { stem: false, removeStopWords: false })
  if (fieldResult.tokens.length === 0) {
    return { snippet: text, positions: [] }
  }

  const lowercaseText = text.normalize('NFC').toLowerCase()
  const charOffsets = buildTokenCharOffsets(lowercaseText, fieldResult.originalTokens)

  const stemmedQueryTokens = queryTokens.map(qt => {
    if (language.stemmer) {
      return language.stemmer(qt.token.toLowerCase())
    }
    return qt.token.toLowerCase()
  })

  const matchedRanges: CharRange[] = []

  for (let i = 0; i < fieldResult.tokens.length; i++) {
    const fieldToken = fieldResult.tokens[i].token
    const stemmedField = language.stemmer ? language.stemmer(fieldToken) : fieldToken

    for (const stemmedQuery of stemmedQueryTokens) {
      if (stemmedField === stemmedQuery && charOffsets[i]) {
        matchedRanges.push({ start: charOffsets[i].start, end: charOffsets[i].end })
        break
      }
    }
  }

  const mergedPositions = mergeOverlapping(matchedRanges)

  if (mergedPositions.length === 0) {
    if (maxSnippetLength > 0 && text.length > maxSnippetLength) {
      const truncated = text.substring(0, maxSnippetLength)
      return { snippet: `${truncated}...`, positions: [] }
    }
    return { snippet: text, positions: [] }
  }

  if (maxSnippetLength > 0 && text.length > maxSnippetLength) {
    const { snippet, adjustedPositions } = applySnippetTruncation(
      text,
      text,
      mergedPositions,
      maxSnippetLength,
      preTag,
      postTag,
    )
    return { snippet, positions: adjustedPositions }
  }

  let result = text
  const sortedDesc = [...mergedPositions].sort((a, b) => b.start - a.start)
  for (const pos of sortedDesc) {
    result =
      result.substring(0, pos.start) +
      preTag +
      result.substring(pos.start, pos.end) +
      postTag +
      result.substring(pos.end)
  }

  return { snippet: result, positions: mergedPositions }
}
