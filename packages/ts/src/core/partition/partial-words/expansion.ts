import { fuzzyTermMatches } from '../../fuzzy'
import { compareCodePoints } from '../../ordering'
import type { PartitionReadState } from '../read-state'
import { partitionDocumentFrequency } from '../suggestions'
import type { PartialWordAnalysis } from './spellings'
import { partialWordProbe } from './text'
import type { AddedWord, PartialWordReader, PartialWordRequest } from './types'

interface RankedWord {
  token: string
  documents: number
  spellingLength: number
}

function excludedFromRequest(request: PartialWordRequest, token: string): boolean {
  if (token === request.ownToken) return true
  return request.tolerance > 0 && fuzzyTermMatches(request.ownToken, token, request.tolerance, request.prefixLength)
}

function addedWordsFor(
  subs: readonly PartitionReadState[],
  readers: readonly PartialWordReader[],
  request: PartialWordRequest,
): AddedWord[] {
  if (request.share <= 0) return []
  const probe = partialWordProbe(request.written)
  const shortestSpelling = new Map<string, number>()
  for (const reader of readers) {
    reader.forEachContaining(probe, (token, spellingLength) => {
      const known = shortestSpelling.get(token)
      if (known === undefined || spellingLength < known) shortestSpelling.set(token, spellingLength)
    })
  }

  const ranked: RankedWord[] = []
  for (const [token, spellingLength] of shortestSpelling) {
    if (excludedFromRequest(request, token)) continue
    const documents = partitionDocumentFrequency(subs, token)
    if (documents > 0) ranked.push({ token, documents, spellingLength })
  }
  ranked.sort((a, b) => b.documents - a.documents || compareCodePoints(a.token, b.token))
  if (ranked.length > request.share) ranked.length = request.share

  const writtenLength = probe.codePoints.length
  return ranked.map(word => ({ token: word.token, factor: writtenLength / word.spellingLength }))
}

export function expandPartialWords(
  subs: readonly PartitionReadState[],
  analysis: PartialWordAnalysis,
  requests: readonly PartialWordRequest[],
): AddedWord[][] {
  const readers: PartialWordReader[] = []
  for (const sub of subs) {
    const reader = sub.partialWords.readerFor(analysis)
    if (reader !== null) readers.push(reader)
  }
  return requests.map(request => (readers.length === 0 ? [] : addedWordsFor(subs, readers, request)))
}
