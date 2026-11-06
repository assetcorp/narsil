import { ErrorCodes, NarsilError } from '../errors'
import type { AnyDocument } from '../types/schema'
import { BUILD_LIST_PAGE, BUILD_WRITE_BATCH, SUGGESTIONS_INDEX_INFIX } from './constants'
import type { SuggestionsHost } from './host'

export const ORIGIN_POPULAR = 'popular'
export const ORIGIN_MANUAL = 'manual'

export interface StoredSuggestion {
  count: number
  origin: string
}

export interface GroupChanges {
  published: number
  removed: number
}

export function suggestionsIndexName(indexName: string, group: string): string {
  return `${indexName}${SUGGESTIONS_INDEX_INFIX}${group}`
}

export function suggestionDocument(phrase: string, count: number, origin: string): AnyDocument {
  return { id: phrase, query: phrase, count, origin }
}

export function markedSuggestionIndexes(host: SuggestionsHost, indexName: string): Map<string, string> {
  const byGroup = new Map<string, string>()
  for (const name of host.indexNames()) {
    const source = host.view(name)?.state?.querySuggestionsSource
    if (source?.index === indexName) byGroup.set(source.group, name)
  }
  return byGroup
}

export async function ensureSuggestionsIndex(
  host: SuggestionsHost,
  indexName: string,
  group: string,
  created: string[] = [],
): Promise<string> {
  const name = suggestionsIndexName(indexName, group)
  const source = host.view(indexName)
  if (source === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, { indexName })
  }
  const existing = host.view(name)
  if (existing === null) {
    await host.createSuggestionsIndex(name, { index: indexName, group }, source.language)
    created.push(name)
    return name
  }
  const marker = existing.state?.querySuggestionsSource
  if (marker?.index !== indexName || marker.group !== group) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index "${name}" exists without the marker of a suggestions index for "${indexName}", so the build leaves it alone`,
      { indexName: name },
    )
  }
  if (existing.language !== source.language) {
    await host.engine.changeAnalysis(name, { language: source.language })
  }
  return name
}

export async function readSuggestions(host: SuggestionsHost, name: string): Promise<Map<string, StoredSuggestion>> {
  const stored = new Map<string, StoredSuggestion>()
  let cursor: string | undefined
  do {
    const page = await host.engine.listDocuments<AnyDocument>(name, {
      limit: BUILD_LIST_PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    for (const { id, document } of page.documents) {
      const count = typeof document.count === 'number' ? document.count : 0
      const origin = typeof document.origin === 'string' ? document.origin : ORIGIN_POPULAR
      stored.set(id, { count, origin })
    }
    cursor = page.cursor ?? undefined
  } while (cursor !== undefined)
  return stored
}

function requireWritten(result: { failed: Array<{ docId: string; error: NarsilError }> }): void {
  const first = result.failed[0]
  if (first !== undefined) throw first.error
}

async function removeBatchOf(host: SuggestionsHost, name: string, ids: readonly string[]): Promise<string[]> {
  const result = await host.engine.removeBatch(name, [...ids])
  for (const failure of result.failed) {
    if (failure.error.code !== ErrorCodes.DOC_NOT_FOUND) throw failure.error
  }
  return result.succeeded
}

export async function removeSuggestions(host: SuggestionsHost, name: string, ids: readonly string[]): Promise<number> {
  let removed = 0
  for (let start = 0; start < ids.length; start += BUILD_WRITE_BATCH) {
    removed += (await removeBatchOf(host, name, ids.slice(start, start + BUILD_WRITE_BATCH))).length
  }
  return removed
}

export interface UndoStep {
  name: string
  remove: string[]
  restore: Array<{ phrase: string; stored: StoredSuggestion }>
}

function restoreDocument(entry: { phrase: string; stored: StoredSuggestion }): AnyDocument {
  return suggestionDocument(entry.phrase, entry.stored.count, entry.stored.origin)
}

export async function undoWrites(
  host: SuggestionsHost,
  steps: readonly UndoStep[],
  banned: ReadonlySet<string>,
): Promise<void> {
  for (const step of [...steps].reverse()) {
    await removeSuggestions(host, step.name, step.remove)
    const restore = step.restore.filter(entry => !banned.has(entry.phrase))
    for (let start = 0; start < restore.length; start += BUILD_WRITE_BATCH) {
      const batch = restore.slice(start, start + BUILD_WRITE_BATCH)
      await removeSuggestions(
        host,
        step.name,
        batch.map(entry => entry.phrase),
      )
      requireWritten(await host.engine.insertBatch(step.name, batch.map(restoreDocument)))
    }
  }
}

interface PlannedWrites {
  inserts: AnyDocument[]
  updates: Array<{ phrase: string; count: number; previous: StoredSuggestion }>
  stale: Array<{ phrase: string; stored: StoredSuggestion }>
  banned: string[]
}

function planWrites(
  stored: ReadonlyMap<string, StoredSuggestion>,
  due: ReadonlyMap<string, number>,
  banned: ReadonlySet<string>,
  onlyAdd: boolean,
): PlannedWrites {
  const plan: PlannedWrites = { inserts: [], updates: [], stale: [], banned: [] }
  for (const [phrase, count] of due) {
    if (banned.has(phrase)) continue
    const current = stored.get(phrase)
    if (current === undefined) plan.inserts.push(suggestionDocument(phrase, count, ORIGIN_POPULAR))
    else if (current.origin === ORIGIN_POPULAR && current.count !== count) {
      plan.updates.push({ phrase, count, previous: current })
    }
  }
  for (const [phrase, current] of stored) {
    if (banned.has(phrase)) plan.banned.push(phrase)
    else if (!onlyAdd && current.origin === ORIGIN_POPULAR && !due.has(phrase)) {
      plan.stale.push({ phrase, stored: current })
    }
  }
  return plan
}

export async function writeGroup(
  host: SuggestionsHost,
  name: string,
  due: ReadonlyMap<string, number>,
  banned: ReadonlySet<string>,
  onlyAdd: boolean,
  undo: UndoStep[],
): Promise<GroupChanges> {
  const plan = planWrites(await readSuggestions(host, name), due, banned, onlyAdd)
  const step: UndoStep = { name, remove: [], restore: [] }
  undo.push(step)
  for (let start = 0; start < plan.inserts.length; start += BUILD_WRITE_BATCH) {
    const result = await host.engine.insertBatch(name, plan.inserts.slice(start, start + BUILD_WRITE_BATCH))
    step.remove.push(...result.succeeded)
    requireWritten(result)
  }
  for (let start = 0; start < plan.updates.length; start += BUILD_WRITE_BATCH) {
    const batch = plan.updates.slice(start, start + BUILD_WRITE_BATCH)
    const result = await host.engine.updateBatch(
      name,
      batch.map(entry => ({
        docId: entry.phrase,
        document: suggestionDocument(entry.phrase, entry.count, ORIGIN_POPULAR),
      })),
    )
    const succeeded = new Set(result.succeeded)
    for (const entry of batch) {
      if (succeeded.has(entry.phrase)) step.restore.push({ phrase: entry.phrase, stored: entry.previous })
    }
    requireWritten(result)
  }
  let removed = 0
  for (let start = 0; start < plan.stale.length; start += BUILD_WRITE_BATCH) {
    const batch = plan.stale.slice(start, start + BUILD_WRITE_BATCH)
    const succeeded = new Set(
      await removeBatchOf(
        host,
        name,
        batch.map(entry => entry.phrase),
      ),
    )
    removed += succeeded.size
    for (const entry of batch) if (succeeded.has(entry.phrase)) step.restore.push(entry)
  }
  removed += await removeSuggestions(host, name, plan.banned)
  return { published: plan.inserts.length + plan.updates.length, removed }
}
