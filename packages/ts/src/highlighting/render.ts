import type { HighlightMatch } from '../types/results'
import type { CharRange } from './offsets'

function splitsPair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false
  const before = text.charCodeAt(at - 1)
  const after = text.charCodeAt(at)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

function mergeRanges(ranges: CharRange[]): CharRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: CharRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

function windowOf(text: string, spans: readonly CharRange[], maximum: number): CharRange {
  if (maximum <= 0 || text.length <= maximum) return { start: 0, end: text.length }
  let best = 0
  let bestCount = 0
  let first = 0
  let last = 0
  for (const span of spans) {
    const end = Math.min(text.length, Math.max(0, span.start - Math.floor(maximum / 2)) + maximum)
    const start = Math.max(0, end - maximum)
    while (first < spans.length && spans[first].start < start) first++
    if (last < first) last = first
    while (last < spans.length && spans[last].end <= end) last++
    const count = last - first
    if (count > bestCount) {
      best = start
      bestCount = count
    }
  }
  const end = Math.min(text.length, best + maximum)
  return { start: splitsPair(text, best) ? best - 1 : best, end: splitsPair(text, end) ? end + 1 : end }
}

export function renderHighlight(
  text: string,
  ranges: CharRange[],
  preTag: string,
  postTag: string,
  maximum: number,
): HighlightMatch {
  const merged = mergeRanges(ranges)
  const window = windowOf(text, merged, maximum)
  const positions = merged.filter(span => span.start >= window.start && span.end <= window.end)
  const chunks: string[] = []
  if (window.start > 0) chunks.push('...')
  let from = window.start
  for (const span of positions) {
    chunks.push(text.slice(from, span.start), preTag, text.slice(span.start, span.end), postTag)
    from = span.end
  }
  chunks.push(text.slice(from, window.end))
  if (window.end < text.length) chunks.push('...')
  return { snippet: chunks.join(''), positions }
}
