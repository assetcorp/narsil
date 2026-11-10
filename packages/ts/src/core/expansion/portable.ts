import {
  compareCodePoints,
  liveFrequency,
  requireRoom,
  SegmentRefusal,
  termText,
} from '../../engine/optional-reads-host-bindings'
import type { NativeExpansionCore } from '../../vector/native/types/expansion'
import { PREFIX_BUDGET } from './constants'
import { readExpansion } from './regions'
import {
  expansionDictionary,
  expansionOccurrences,
  expansionPrefixes,
  expansionSurfaces,
  expansionToken,
  validExpansionText,
} from './source'

interface Candidate {
  segment: number
  token: number
  documents: number
}

function addCandidate(candidates: Map<string, Candidate>, text: string, segment: number, token: number): void {
  const held = candidates.get(text)
  if (held === undefined || segment < held.segment || (segment === held.segment && token < held.token))
    candidates.set(text, { segment, token, documents: 0 })
}

function pointCount(text: string): number {
  let count = 0
  for (const _point of text) count++
  return count
}

export const expandPrefix: NativeExpansionCore['expandPrefix'] = (
  inputs,
  typed,
  stemmed,
  own,
  outSegments,
  outTokens,
  outFactors,
) => {
  try {
    const { sources, words, segments, tokens, factors } = readExpansion(
      inputs,
      [typed, stemmed, own],
      outSegments,
      outTokens,
      outFactors,
    )
    if (words[0].length === 0) return 0
    const dictionaries = sources.map(expansionDictionary)
    const holdsSurfaces = sources.some(source => !expansionSurfaces(source).next().done)
    const prefixes = !holdsSurfaces && words[1].length > 0 && words[1] !== words[0] ? [typed, stemmed] : [typed]
    const candidates = new Map<string, Candidate>()
    for (let segment = 0; segment < sources.length; segment++) {
      const source = sources[segment]
      const dictionary = dictionaries[segment]
      const totals = new Map<number, number>()
      for (const surface of expansionSurfaces(source)) {
        const matches = validExpansionText(surface.spelling) && surface.spelling.startsWith(words[0])
        if (!matches && source.growing !== null) continue
        const token = expansionToken(dictionary, surface.token)
        if (token === null) continue
        if (source.growing === null) totals.set(token, (totals.get(token) ?? 0) + surface.count)
        if (matches) addCandidate(candidates, surface.token, segment, token)
      }
      for (const prefix of prefixes) {
        for (const token of expansionPrefixes(dictionary, prefix)) {
          if (!(expansionOccurrences(source, token, totals.get(token) ?? 0) > 0)) continue
          const text = termText(dictionary, token)
          if (text !== null && text.length > 0 && validExpansionText(text))
            addCandidate(candidates, text, segment, token)
        }
      }
    }
    const ranked = [...candidates].map(([text, candidate]) => {
      for (const dictionary of dictionaries) {
        const token = expansionToken(dictionary, text)
        if (token !== null) candidate.documents += liveFrequency(dictionary, token)
      }
      return { text, ...candidate }
    })
    ranked.sort((left, right) => right.documents - left.documents || compareCodePoints(left.text, right.text))
    const count = Math.min(PREFIX_BUDGET, ranked.length)
    requireRoom(count <= segments.length && count <= tokens.length && count <= factors.length)
    const ownLength = pointCount(words[2])
    for (let at = 0; at < count; at++) {
      segments[at] = ranked[at].segment
      tokens[at] = ranked[at].token
      factors[at] = Math.min(1, ownLength / pointCount(ranked[at].text))
    }
    return count
  } catch (error) {
    if (error instanceof SegmentRefusal) return -error.status
    throw error
  }
}
