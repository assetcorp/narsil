import {
  type CorpusDocument,
  corpus,
  NEIGHBOURS,
  queryVectors,
  removedDuringSearch,
  WRITE_ROUNDS_DURING_SEARCH,
  writtenDuringSearch,
} from '../src/corpus.ts'
import { checkSameRanking, checkVectorScores, exactNeighbours, type Finding, type RankedHit } from './oracle.ts'

interface AcknowledgedWrite {
  kind: string
  ids: string[]
}

interface QueryDuringWrites {
  query: number
  writesAcknowledgedBefore: number
  writesAcknowledgedAfter: number
  writesStartedAfter: number
  hits: RankedHit[]
}

export interface UnderWrites {
  writes: AcknowledgedWrite[]
  queries: QueryDuringWrites[]
  afterWrites: Array<{ query: number; hits: RankedHit[] }>
}

export interface CheckedUnderWrites {
  findings: Finding[]
  queries: number
  queriesOverlappingWrites: number
}

const LABEL = 'vector search under writes'

function expectedWrites(documents: readonly CorpusDocument[]): AcknowledgedWrite[] {
  const writes: AcknowledgedWrite[] = []
  for (let round = 0; round < WRITE_ROUNDS_DURING_SEARCH; round++) {
    writes.push({ kind: 'remove', ids: removedDuringSearch(documents, round) })
    writes.push({ kind: 'insert', ids: writtenDuringSearch(round).map(document => document.id) })
  }
  return writes
}

function sameWrites(expected: readonly AcknowledgedWrite[], got: readonly AcknowledgedWrite[]): boolean {
  if (expected.length !== got.length) return false
  return expected.every((write, index) => {
    const reported = got[index]
    return (
      reported !== undefined &&
      reported.kind === write.kind &&
      reported.ids.length === write.ids.length &&
      reported.ids.every((id, position) => id === write.ids[position])
    )
  })
}

function idsOf(writes: readonly AcknowledgedWrite[], kind: string): Set<string> {
  return new Set(writes.filter(write => write.kind === kind).flatMap(write => write.ids))
}

export function checkSearchUnderWrites(report: UnderWrites | undefined): CheckedUnderWrites {
  if (report === undefined) {
    return { findings: [{ check: LABEL, detail: 'the phone sent no report' }], queries: 0, queriesOverlappingWrites: 0 }
  }
  const documents = corpus()
  const queries = queryVectors()
  const writes = expectedWrites(documents)
  const findings: Finding[] = []
  if (!sameWrites(writes, report.writes)) {
    findings.push({
      check: LABEL,
      detail: `the phone acknowledged ${report.writes.length} writes out of the planned order`,
    })
  }
  const written = Array.from({ length: WRITE_ROUNDS_DURING_SEARCH }, (_, round) => writtenDuringSearch(round)).flat()
  const known = new Map([...documents, ...written].map(document => [document.id, document]))
  let overlapping = 0
  for (const [position, answer] of report.queries.entries()) {
    const query = queries[answer.query]
    const label = `${LABEL}, query ${position}`
    if (query === undefined) {
      findings.push({ check: label, detail: `query ${answer.query} is unknown` })
      continue
    }
    if (answer.writesStartedAfter > answer.writesAcknowledgedBefore) overlapping++
    const removedBefore = idsOf(writes.slice(0, answer.writesAcknowledgedBefore), 'remove')
    const insertedAfter = idsOf(writes.slice(answer.writesStartedAfter), 'insert')
    for (const hit of answer.hits) {
      if (removedBefore.has(hit.id)) {
        findings.push({ check: label, detail: `${hit.id} came back after its removal was acknowledged` })
      }
      if (insertedAfter.has(hit.id)) {
        findings.push({ check: label, detail: `${hit.id} came back although its insert began after the query` })
      }
    }
    findings.push(...checkVectorScores(known, query, answer.hits, label))
  }
  if (overlapping === 0) {
    findings.push({ check: LABEL, detail: `none of the ${report.queries.length} queries overlapped a write` })
  }
  const removed = idsOf(writes, 'remove')
  const live = [...documents.filter(document => !removed.has(document.id)), ...written]
  if (report.afterWrites.length !== queries.length) {
    findings.push({
      check: LABEL,
      detail: `the phone answered ${report.afterWrites.length} of ${queries.length} queries after the writes`,
    })
  }
  for (const answer of report.afterWrites) {
    const query = queries[answer.query]
    const label = `${LABEL}, query ${answer.query} after the writes`
    if (query === undefined) {
      findings.push({ check: label, detail: 'the query is unknown' })
      continue
    }
    findings.push(...checkSameRanking(exactNeighbours(live, query, NEIGHBOURS), answer.hits, label))
  }
  return { findings, queries: report.queries.length, queriesOverlappingWrites: overlapping }
}
