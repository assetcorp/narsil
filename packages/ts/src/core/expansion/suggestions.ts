import type { NativeExpansionCore, NativeExpansionSegment } from '../../vector/native/types/expansion'
import { compareCodePoints } from '../ordering'
import { regionsOverlap } from '../regions'
import { requireRoom, requireSegment, SegmentRefusal } from '../segment-writes/status'
import { typedRegion } from '../stored-values/regions'
import { liveFrequency, termText } from '../term-table/read'
import { readExpansion } from './regions'
import {
  expansionDictionary,
  expansionOccurrences,
  expansionPrefixes,
  expansionSurfaces,
  expansionToken,
} from './source'

interface Spelling {
  text: string
  segment: number
  kind: number
  ordinal: number
  occurrences: number
}

interface Suggestion {
  text: string
  segment: number
  token: number
  documents: number
  spellings: Map<string, Spelling>
}

function sourceSuggestions(
  source: NativeExpansionSegment,
  segment: number,
  typed: Uint16Array,
  stemmed: Uint16Array,
  written: string,
  reduced: string,
): Map<string, Suggestion> {
  const dictionary = expansionDictionary(source)
  const grouped = new Map<string, Suggestion>()
  const totals = new Map<number, number>()
  let holdsSurfaces = false
  function append(text: string, token: number, spelling: Spelling): void {
    let group = grouped.get(text)
    if (group === undefined) {
      group = { text, segment, token, documents: liveFrequency(dictionary, token), spellings: new Map() }
      grouped.set(text, group)
    }
    if (!group.spellings.has(spelling.text)) group.spellings.set(spelling.text, spelling)
  }
  for (const surface of expansionSurfaces(source)) {
    holdsSurfaces = true
    const token = expansionToken(dictionary, surface.token)
    if (token === null) continue
    totals.set(token, (totals.get(token) ?? 0) + surface.count)
    if (surface.spelling.startsWith(written))
      append(surface.token, token, {
        text: surface.spelling,
        segment,
        kind: 1,
        ordinal: surface.entry,
        occurrences: surface.count,
      })
  }
  const prefixes = !holdsSurfaces && reduced.length > 0 && written !== reduced ? [typed, stemmed] : [typed]
  for (const prefix of prefixes) {
    for (const token of expansionPrefixes(dictionary, prefix)) {
      const occurrences = expansionOccurrences(source, token, totals.get(token) ?? 0)
      if (!(occurrences > 0)) continue
      const text = termText(dictionary, token)
      if (text !== null) append(text, token, { text, segment, kind: 0, ordinal: token, occurrences })
    }
  }
  return grouped
}

export const suggestTerms: NativeExpansionCore['suggestTerms'] = (
  sources,
  typed,
  stemmed,
  limit,
  outTerms,
  outStarts,
  outSpellings,
  outOccurrences,
) => {
  try {
    const held = readExpansion(sources, [typed, stemmed], outTerms, outSpellings, outOccurrences)
    requireSegment(Number.isInteger(limit) && limit >= 0 && limit <= 0xffffffff)
    const starts = typedRegion(outStarts, 'Uint32Array')
    requireSegment(starts !== null)
    for (const region of [...held.arrays, held.segments, held.tokens, held.factors])
      requireSegment(!regionsOverlap(starts, region))
    const groups = new Map<string, Suggestion>()
    if (held.words[0].length > 0 && limit > 0) {
      for (let segment = 0; segment < held.sources.length; segment++) {
        const local = sourceSuggestions(held.sources[segment], segment, typed, stemmed, held.words[0], held.words[1])
        for (const [text, next] of local) {
          const previous = groups.get(text)
          if (previous === undefined) groups.set(text, next)
          else {
            previous.documents += next.documents
            requireSegment(previous.documents <= 0xffffffff)
            for (const [spelling, value] of next.spellings) {
              const existing = previous.spellings.get(spelling)
              if (existing === undefined) previous.spellings.set(spelling, value)
              else existing.occurrences += value.occurrences
            }
          }
        }
      }
    }
    const ranked = [...groups.values()]
    ranked.sort((left, right) => right.documents - left.documents || compareCodePoints(left.text, right.text))
    if (ranked.length > limit) ranked.length = limit
    const spellings = ranked.map(group =>
      [...group.spellings.values()].sort(
        (left, right) => right.occurrences - left.occurrences || compareCodePoints(left.text, right.text),
      ),
    )
    const needed = spellings.reduce((count, entries) => count + entries.length, 0)
    requireSegment(needed <= 0xffffffff)
    requireRoom(
      ranked.length <= Math.floor(held.segments.length / 3) &&
        starts.length >= ranked.length + 1 &&
        needed <= Math.floor(held.tokens.length / 3) &&
        needed <= held.factors.length,
    )
    let next = 0
    starts[0] = 0
    for (let at = 0; at < ranked.length; at++) {
      const group = ranked[at]
      held.segments.set([group.segment, group.token, group.documents], at * 3)
      for (const spelling of spellings[at]) {
        held.tokens.set([spelling.segment, spelling.kind, spelling.ordinal], next * 3)
        held.factors[next++] = spelling.occurrences
      }
      starts[at + 1] = next
    }
    return ranked.length
  } catch (error) {
    if (error instanceof SegmentRefusal) return -error.status
    throw error
  }
}
