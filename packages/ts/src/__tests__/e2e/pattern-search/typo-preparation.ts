import { createNarsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'
import { scaledOut, waitFor } from '../../server/helpers'
import { COMMON_TERM, INDEX, SCHEMA } from './corpus'
import { loadCorpus, startPatternServer } from './harness'
import { repeatedCodePoints, searchBody, type TimedResponse, timedSearch } from './hostile'

const CJK_FIRST = 0x4e00
const MOST_TESTS = 1_024
const LONGEST_TEXT = 1_024
const LONG_TEXT = 1_000
const SAMPLED_RUNS = 16
const PARTITIONS = 8
const SHARP_S_FOLD = 2

export interface PreparedFilter {
  label: string
  tests: FieldFilter[]
  preparationUnits: number
  lookupsPerPartition: number
}

export function unitsOverPartitions(filter: PreparedFilter, partitions: number): number {
  return filter.preparationUnits + filter.lookupsPerPartition * partitions
}

function distinctLongTexts(count: number): string[] {
  return Array.from({ length: count }, (_, at) => repeatedCodePoints(CJK_FIRST + at, LONG_TEXT))
}

export function longDistinctTextFilter(): PreparedFilter {
  return {
    label: 'tolerance 2 on long distinct text',
    tests: distinctLongTexts(MOST_TESTS).map(eq => ({ eq, tolerance: 2 })),
    preparationUnits: MOST_TESTS * (LONG_TEXT + SAMPLED_RUNS),
    lookupsPerPartition: MOST_TESTS * SAMPLED_RUNS,
  }
}

export function caseFoldFilter(): PreparedFilter {
  return {
    label: 'tolerance 2 under caseFold, which also copies the folded text',
    tests: distinctLongTexts(MOST_TESTS).map(eq => ({ eq, tolerance: 2, caseFold: true })),
    preparationUnits: MOST_TESTS * (LONG_TEXT + SAMPLED_RUNS + LONG_TEXT),
    lookupsPerPartition: MOST_TESTS * SAMPLED_RUNS,
  }
}

export function autoResolvingToExactFilter(): PreparedFilter {
  const positions = LONG_TEXT - 2
  return {
    label: 'tolerance auto on text that resolves to an exact test',
    tests: Array.from({ length: MOST_TESTS }, (_, at) => ({
      eq: String.fromCodePoint(CJK_FIRST + at).repeat(LONG_TEXT),
      tolerance: 'auto' as const,
    })),
    preparationUnits: MOST_TESTS * (LONG_TEXT + SAMPLED_RUNS + positions),
    lookupsPerPartition: MOST_TESTS,
  }
}

export function longestFoldFilter(): PreparedFilter {
  const otherCodePoints = 4
  const foldedLength = (LONGEST_TEXT - otherCodePoints) * SHARP_S_FOLD + otherCodePoints
  const positions = foldedLength - 2
  const distinctRuns = 5
  return {
    label: 'the longest fold under caseFold, with too few distinct runs to stop early',
    tests: Array.from({ length: MOST_TESTS }, (_, at) => ({
      eq: `${'ß'.repeat(LONGEST_TEXT - otherCodePoints)}${repeatedCodePoints(CJK_FIRST + at, otherCodePoints)}`,
      tolerance: 1,
      caseFold: true,
    })),
    preparationUnits: MOST_TESTS * (LONGEST_TEXT + SAMPLED_RUNS + positions + foldedLength),
    lookupsPerPartition: MOST_TESTS * distinctRuns,
  }
}

export function repeatedTestFilter(): PreparedFilter {
  const distinct = MOST_TESTS / 2
  const texts = distinctLongTexts(distinct)
  return {
    label: 'each test held twice, which prepares once',
    tests: [...texts, ...texts].map(eq => ({ eq, tolerance: 2 })),
    preparationUnits: distinct * (LONG_TEXT + SAMPLED_RUNS),
    lookupsPerPartition: MOST_TESTS * SAMPLED_RUNS,
  }
}

export function filterOf(filter: PreparedFilter): { or: Array<{ fields: { line: FieldFilter } }> } {
  return { or: filter.tests.map(line => ({ fields: { line } })) }
}

export async function typoAnswerUnderCap(
  corpus: AnyDocument[],
  workers: NarsilConfig['workers'],
  patternWorkCap: number,
  filter: PreparedFilter,
): Promise<TimedResponse> {
  const server = await startPatternServer({ workers, patternWorkCap })
  try {
    await loadCorpus(server, corpus, 1)
    return await timedSearch(server, searchBody(filterOf(filter)))
  } finally {
    await server.stop()
  }
}

export interface EngineAnswer {
  code: string | null
  count: number | null
}

export async function answerAtWorkerCount(
  corpus: AnyDocument[],
  count: number,
  capFor: (partitions: number) => number | undefined,
  filter: PreparedFilter,
): Promise<EngineAnswer> {
  const partitionProbe = PARTITIONS
  const patternWorkCap = capFor(partitionProbe)
  const narsil = await createNarsil({
    workers: { promotionThreshold: 200, count, mainCopyQueries: 'none' },
    ...(patternWorkCap === undefined ? {} : { patternWorkCap }),
  })
  try {
    await narsil.createIndex(INDEX, { schema: SCHEMA, partitions: { maxPartitions: PARTITIONS } })
    await narsil.insertBatch(INDEX, corpus)
    await waitFor(() => scaledOut(narsil, INDEX))
    const { partitionCount } = await narsil.getStats(INDEX)
    if (partitionCount !== partitionProbe) throw new Error(`The index holds ${partitionCount} partitions`)
    const result = await narsil.query(INDEX, { term: COMMON_TERM, filters: filterOf(filter), limit: 10 })
    return { code: null, count: result.count }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === undefined) throw err
    return { code, count: null }
  } finally {
    await narsil.shutdown()
  }
}
