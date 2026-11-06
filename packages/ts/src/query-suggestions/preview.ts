import type { QuerySuggestionPreviewEntry, QuerySuggestionsPreview } from '../types/query-suggestions'
import { type BuildContext, enabledSetting, groupsToWrite, meetsMinResults, mergeHistory } from './build'

function previewOrder(left: QuerySuggestionPreviewEntry, right: QuerySuggestionPreviewEntry): number {
  if (left.count !== right.count) return right.count - left.count
  if (left.group !== right.group) return left.group < right.group ? -1 : 1
  return left.query < right.query ? -1 : left.query > right.query ? 1 : 0
}

export async function previewBuild(
  ctx: BuildContext,
  indexName: string,
  max: number,
): Promise<QuerySuggestionsPreview> {
  const setting = enabledSetting(ctx.host, indexName)
  const merged = await mergeHistory(ctx, indexName, setting, Date.now())
  const { groups } = groupsToWrite(ctx, indexName, setting, merged.result)
  const banned = new Set(ctx.host.view(indexName)?.state?.bannedQueries ?? [])
  const candidates: QuerySuggestionPreviewEntry[] = []
  for (const group of groups) {
    for (const { phrase, count } of merged.result.groups[group] ?? []) {
      if (!banned.has(phrase)) candidates.push({ group, query: phrase, count })
    }
  }
  candidates.sort(previewOrder)
  const checked = new Map<string, boolean>()
  const entries: QuerySuggestionPreviewEntry[] = []
  let next = 0
  while (next < candidates.length && entries.length < max) {
    const candidate = candidates[next]
    next += 1
    if (candidate === undefined) break
    let passes = checked.get(candidate.query)
    if (passes === undefined) {
      passes = await meetsMinResults(ctx, indexName, setting, candidate.query)
      checked.set(candidate.query, passes)
    }
    if (passes) entries.push(candidate)
  }
  return { entries, truncated: next < candidates.length }
}
