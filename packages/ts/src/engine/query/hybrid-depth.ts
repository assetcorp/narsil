import type { FanOutResult } from '../../partitioning/fan-out'
import type { RuntimeHost } from '../../rerank/host'
import { HYBRID_RESCORE_WINDOW } from '../../search/constants'
import { fixedHybridDepthOf, requireWithinHybridDepth } from '../../search/hybrid-depth'
import { type PositionedHit, pageByPosition } from '../../search/position-page'
import type { ScoredDocument } from '../../types/internal'
import type { QueryParams } from '../../types/search'
import type { SearchContext } from './shared'

export interface FixedDepthWindow {
  cursorDepth: number
  offset: number
  limit: number
}

export interface FixedDepthHybrid {
  result: FanOutResult
  page<T extends PositionedHit>(
    placed: T[],
    organic: T[],
    pinnedIds: ReadonlySet<string> | undefined,
  ): { page: T[]; cursor?: string }
}

function countOfUnion(text: FanOutResult, vectorScored: ScoredDocument[]): number {
  const textIds = new Set<string>()
  for (const doc of text.scored) textIds.add(doc.docId)
  let vectorOnly = 0
  for (const doc of vectorScored) if (!textIds.has(doc.docId)) vectorOnly++
  if (text.scored.length === text.totalMatched) return text.totalMatched + vectorOnly
  return Math.max(text.totalMatched, text.scored.length + vectorOnly)
}

async function fusedAtDepth(
  params: QueryParams,
  context: SearchContext,
  depth: number,
  legs: RuntimeHost,
): Promise<FanOutResult> {
  const { manager, config } = context
  const { textLeg, vectorLeg } = legs
  const { vector: vectorConfig, mode: _mode, hybrid: _hybrid, searchAfter: _after, pinned: _pinned, ...rest } = params
  const fusion = legs.resolveHybridFusion(params.hybrid)
  const textOnlyParams: QueryParams = { ...rest, limit: depth, offset: 0 }

  let filterDocIds: Set<string> | undefined
  if (params.filters) {
    filterDocIds = legs.collectFilterDocIds(manager, params, config.schema, context.partitionIds, context.patternWork)
    if (filterDocIds.size === 0) {
      return { scored: [], totalMatched: 0 }
    }
  }

  if (!vectorConfig || !vectorConfig.value) {
    const textOnly = await textLeg(textOnlyParams, context)
    return { scored: textOnly.scored, totalMatched: textOnly.totalMatched, facets: textOnly.facets }
  }

  const vectorPending = vectorLeg(
    vectorConfig,
    new Float32Array(vectorConfig.value),
    context,
    filterDocIds,
    depth,
    HYBRID_RESCORE_WINDOW,
  )
  const [textFanOutResult, vectorOutcome] = await Promise.all([textLeg(textOnlyParams, context), vectorPending])
  const vectorScored = vectorOutcome.scored
  const textScored = textFanOutResult.scored.slice(0, depth)

  let fusedScored: ScoredDocument[]
  if (fusion.strategy === 'rrf') {
    fusedScored = legs.reciprocalRankFusion([textScored, vectorScored], { k: fusion.k })
  } else {
    fusedScored = legs.linearCombination(textScored, vectorScored, { alpha: fusion.alpha })
  }

  const textHoldsEveryMatch = textFanOutResult.scored.length === textFanOutResult.totalMatched
  const threshold = params.minScore ?? 0
  const filtersByScore = threshold > 0
  if (filtersByScore) fusedScored = fusedScored.filter(doc => doc.score >= threshold)

  return {
    scored: fusedScored.length > depth ? fusedScored.slice(0, depth) : fusedScored,
    totalMatched: filtersByScore ? fusedScored.length : countOfUnion(textFanOutResult, vectorScored),
    matchedExact:
      vectorOutcome.holdsEveryMatch &&
      textHoldsEveryMatch &&
      (!filtersByScore || textScored.length === textFanOutResult.totalMatched),
    facets: textFanOutResult.facets,
  }
}

export async function searchFixedDepthHybrid(
  params: QueryParams,
  context: SearchContext,
  { cursorDepth, offset, limit }: FixedDepthWindow,
  host: RuntimeHost,
): Promise<FixedDepthHybrid> {
  const depth = fixedHybridDepthOf(params.hybrid) ?? 0
  requireWithinHybridDepth(cursorDepth, offset, depth)
  return {
    result: await fusedAtDepth(params, context, depth, host),
    page: (placed, organic, pinnedIds) =>
      pageByPosition(placed, organic, {
        start: cursorDepth + offset,
        limit,
        pinnedIds,
        binding: context.cursorBinding,
        encodeCursor: host.encodePageCursor,
      }),
  }
}
