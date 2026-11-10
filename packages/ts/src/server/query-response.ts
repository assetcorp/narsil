import { encodeScore } from '../score-encoding'
import type { GroupResult, Hit, QueryResult } from '../types/results'
import type { HttpGroupResult, HttpHit, HttpQueryResult } from './types/wire'

function encodeHits(hits: Hit[]): HttpHit[] {
  let encoded: HttpHit[] | undefined
  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index]
    if (hit.score === undefined || Number.isFinite(hit.score)) continue
    encoded ??= hits.slice()
    encoded[index] = { ...hit, score: encodeScore(hit.score) }
  }
  return encoded ?? hits
}

function encodeGroups(groups: GroupResult[] | undefined): HttpGroupResult[] | undefined {
  if (groups === undefined) return undefined
  let encoded: HttpGroupResult[] | undefined
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    const hits = encodeHits(group.hits)
    if (hits === group.hits) continue
    encoded ??= groups.slice()
    encoded[index] = { ...group, hits }
  }
  return encoded ?? groups
}

export function encodeQueryResult(answer: QueryResult): HttpQueryResult {
  const hits = encodeHits(answer.hits)
  const groups = encodeGroups(answer.groups)
  return hits === answer.hits && groups === answer.groups ? answer : { ...answer, hits, groups }
}
