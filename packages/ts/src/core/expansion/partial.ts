import type { NativePartialExpansionCore } from '../../vector/native/types/partial-expansion'
import { fuzzyTermMatches } from '../fuzzy'
import { compareCodePoints } from '../ordering'
import { codePointCount } from '../ordering/code-points'
import { requireRoom, SegmentRefusal } from '../segment-writes/status'
import { liveFrequency, termText } from '../term-table/read'
import {
  expansionDictionary,
  expansionToken,
  PARTIAL_BUDGET,
  PARTIAL_RUN_POINTS,
  validExpansionText,
} from './partial-bindings'
import { readPartialExpansion } from './partial-regions'
import { partialMembers, partialSpelling } from './partial-source'

interface Addition {
  text: string
  segment: number
  token: number
  length: number
  documents: number
}

export const expandPartialWords: NativePartialExpansionCore['expandPartialWords'] = (...args) => {
  try {
    const held = readPartialExpansion(...args)
    const dictionaries = held.sources.map(expansionDictionary)
    const lengths = held.queries.map(query => codePointCount(query.written))
    const eligible = Math.min(PARTIAL_BUDGET, lengths.filter(length => length >= PARTIAL_RUN_POINTS).length)
    const output: Array<{ segment: number; token: number; factor: number }> = []
    const starts = [0]
    let order = 0
    for (let queryAt = 0; queryAt < held.queries.length; queryAt++) {
      const query = held.queries[queryAt]
      if (lengths[queryAt] < PARTIAL_RUN_POINTS || order >= PARTIAL_BUDGET) {
        starts.push(output.length)
        continue
      }
      const share = Math.floor(PARTIAL_BUDGET / eligible) + (order++ < PARTIAL_BUDGET % eligible ? 1 : 0)
      const points = Array.from(query.written, character => character.codePointAt(0) ?? 0)
      const candidates = new Map<string, Addition>()
      for (let segment = 0; segment < held.sources.length; segment++) {
        const source = held.sources[segment]
        const dictionary = dictionaries[segment]
        for (const entry of partialMembers(source, held.runs[segment], points) ?? []) {
          const spelling = partialSpelling(source, entry)
          if (spelling === null || !spelling.text.includes(query.written)) continue
          const length = codePointCount(spelling.text)
          if (length <= points.length) continue
          const text = termText(dictionary, spelling.token)
          if (text === null || !validExpansionText(text) || liveFrequency(dictionary, spelling.token) === 0) continue
          if (fuzzyTermMatches(query.own, text, query.tolerance, query.prefixLength)) continue
          const previous = candidates.get(text)
          if (previous !== undefined) {
            previous.length = Math.min(previous.length, length)
            if (segment < previous.segment || (segment === previous.segment && spelling.token < previous.token)) {
              previous.segment = segment
              previous.token = spelling.token
            }
          } else candidates.set(text, { text, segment, token: spelling.token, length, documents: 0 })
        }
      }
      const ranked = [...candidates.values()]
      for (const candidate of ranked) {
        for (const dictionary of dictionaries) {
          const token = expansionToken(dictionary, candidate.text)
          if (token !== null) candidate.documents += liveFrequency(dictionary, token)
        }
      }
      ranked.sort((left, right) => right.documents - left.documents || compareCodePoints(left.text, right.text))
      for (let at = 0; at < Math.min(share, ranked.length); at++) {
        const candidate = ranked[at]
        output.push({ segment: candidate.segment, token: candidate.token, factor: points.length / candidate.length })
      }
      starts.push(output.length)
    }
    requireRoom(
      output.length <= held.segments.length &&
        output.length <= held.tokens.length &&
        output.length <= held.factors.length,
    )
    for (let at = 0; at < output.length; at++) {
      held.segments[at] = output[at].segment
      held.tokens[at] = output[at].token
      held.factors[at] = output[at].factor
    }
    held.starts.set(starts)
    return output.length
  } catch (error) {
    if (error instanceof SegmentRefusal) return -error.status
    throw error
  }
}
