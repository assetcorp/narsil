import { compareCodePoints } from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import type { QuerySuggestionsWarningReason } from '../types/query-suggestions'
import { type BuildRecord, type MergedSource, sourcesDigestOf } from './build-record'
import { DAY_MS, MS_PER_SECOND } from './constants'
import { sameBytes } from './counts-file'
import { dayOf } from './day-store'
import { type HistoryFileName, historyFileOf, listHistoryFolder } from './history-files'
import type { SuggestionsHost } from './host'
import type { DuePhrase, MergeResult } from './merge'
import { type MergeSession, startMerge } from './merge-run'
import type { PersonScrambler } from './scramble'
import { type ResolvedSetting, resolveSetting } from './setting'
import {
  ensureSuggestionsIndex,
  markedSuggestionIndexes,
  type UndoStep,
  undoWrites,
  writeGroup,
} from './suggestions-writer'

export interface BuildContext {
  host: SuggestionsHost
  scrambler: PersonScrambler
  saveDay(indexName: string): Promise<void>
  withWriteLock<T>(indexName: string, work: () => Promise<T>): Promise<T>
  isStopping(): boolean
}

export interface MergedHistory {
  result: MergeResult
  sources: MergedSource[]
  oldestDay: string | null
  silentNodes: number
}

type BuildOutcome = Pick<BuildRecord, 'status' | 'published' | 'removed' | 'discarded' | 'sourcesDigest'>

export function enabledSetting(host: SuggestionsHost, indexName: string): ResolvedSetting {
  const view = host.view(indexName)
  if (view === null)
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, { indexName })
  const setting = view.state?.querySuggestions
  if (setting === undefined || !setting.enabled) {
    throw new NarsilError(
      ErrorCodes.QUERY_SUGGESTIONS_NOT_ENABLED,
      `Index "${indexName}" has popular query suggestions off`,
      { indexName },
    )
  }
  return resolveSetting(setting)
}

function cutoffDay(now: number, retentionDays: number): string {
  return dayOf(now - retentionDays * DAY_MS)
}

function warn(host: SuggestionsHost, indexName: string, reason: QuerySuggestionsWarningReason, file: string): void {
  host.emit('querySuggestionsWarning', { indexName, reason, file })
}

async function mergeFile(
  ctx: BuildContext,
  session: MergeSession,
  merged: MergedHistory,
  indexName: string,
  file: { nodeId: string; key: string; day: string; bytes: Uint8Array },
  removeLocal: (() => Promise<void>) | null,
): Promise<void> {
  const outcome = await session.addFile({ day: file.day, bytes: file.bytes })
  if (outcome.kind === 'merged') {
    merged.sources.push({ nodeId: file.nodeId, key: file.key, savedAt: outcome.savedAt })
    if (merged.oldestDay === null || outcome.day < merged.oldestDay) merged.oldestDay = outcome.day
    return
  }
  if (outcome.kind === 'other-index') {
    warn(ctx.host, indexName, 'damaged-file', file.key)
    await removeLocal?.()
    return
  }
  warn(ctx.host, indexName, outcome.kind === 'other-key' ? 'other-key' : 'damaged-file', file.key)
}

export async function mergeHistory(
  ctx: BuildContext,
  indexName: string,
  setting: ResolvedSetting,
  now: number,
): Promise<MergedHistory> {
  const { host } = ctx
  const view = host.view(indexName)
  await ctx.saveDay(indexName)
  const cutoff = cutoffDay(now, setting.retentionDays)
  const session = await startMerge(
    {
      minPeople: setting.minPeople,
      maxMergePhrases: setting.maxMergePhrases,
      maxGroups: setting.maxGroups,
      markedGroups: [...markedSuggestionIndexes(host, indexName).keys()],
      fingerprint: ctx.scrambler.fingerprint,
      indexUuid: view?.indexUuid ?? null,
      clustered: host.clustered,
      banned: view?.state?.bannedQueries ?? [],
    },
    setting.mergeMemoryBytes,
  )
  const merged: MergedHistory = { result: { groups: {}, discarded: 0 }, sources: [], oldestDay: null, silentNodes: 0 }
  try {
    let keys: string[]
    try {
      keys = await listHistoryFolder(host.files, indexName)
    } catch (error) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'The node cannot read its query history folder', {
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    const files: HistoryFileName[] = []
    for (const key of keys) {
      const file = historyFileOf(indexName, key)
      if (file !== null && file.day >= cutoff) files.push(file)
    }
    files.sort((left, right) => compareCodePoints(left.key, right.key))
    let localMerged = false
    const mergeLocalFiles = async (): Promise<void> => {
      if (localMerged) return
      localMerged = true
      for (const file of files) {
        const bytes = await host.files.read(file.key)
        if (bytes === null) continue
        if (bytes === 'too-long') {
          warn(host, indexName, 'damaged-file', file.key)
          continue
        }
        await mergeFile(
          ctx,
          session,
          merged,
          indexName,
          { nodeId: host.nodeId, key: file.key, day: file.day, bytes },
          () => host.files.remove(file.key),
        )
      }
    }
    for await (const remote of host.remoteHistory(indexName)) {
      if (remote.kind === 'silent') {
        merged.silentNodes += 1
        continue
      }
      if (compareCodePoints(remote.nodeId, host.nodeId) > 0) await mergeLocalFiles()
      const name = historyFileOf(indexName, remote.key)
      if (name === null || name.day < cutoff) continue
      await mergeFile(ctx, session, merged, indexName, { ...remote, day: name.day }, null)
    }
    await mergeLocalFiles()
    merged.result = await session.finish()
    return merged
  } catch (error) {
    session.abandon()
    throw error
  }
}

async function pace(checksPerSecond: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, MS_PER_SECOND / checksPerSecond))
}

export async function meetsMinResults(
  ctx: BuildContext,
  indexName: string,
  setting: ResolvedSetting,
  phrase: string,
): Promise<boolean> {
  if (ctx.isStopping()) throw new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'The engine is shutting down')
  const checked = await ctx.host.engine.preflight(indexName, { term: phrase, fields: setting.fields, termMatch: 'all' })
  await pace(setting.resultChecksPerSecond)
  return checked.count >= setting.minResults
}

async function choose(
  ctx: BuildContext,
  indexName: string,
  setting: ResolvedSetting,
  phrases: readonly DuePhrase[],
): Promise<Map<string, number>> {
  const due = new Map<string, number>()
  for (const { phrase, count } of phrases) {
    if (await meetsMinResults(ctx, indexName, setting, phrase)) due.set(phrase, count)
  }
  return due
}

export function groupsToWrite(
  ctx: BuildContext,
  indexName: string,
  setting: ResolvedSetting,
  result: MergeResult,
): { groups: string[]; discarded: number } {
  const existing = markedSuggestionIndexes(ctx.host, indexName)
  const groups = [...existing.keys()]
  let discarded = 0
  for (const group of Object.keys(result.groups).sort()) {
    if (existing.has(group)) continue
    if (groups.length < setting.maxGroups) groups.push(group)
    else discarded += result.groups[group]?.length ?? 0
  }
  return { groups, discarded }
}

export async function runBuild(
  ctx: BuildContext,
  indexName: string,
  lastCompleted: BuildRecord | null,
  now: number,
): Promise<BuildOutcome> {
  const setting = enabledSetting(ctx.host, indexName)
  const merged = await mergeHistory(ctx, indexName, setting, now)
  const sourcesDigest = sourcesDigestOf(merged.sources)
  if (lastCompleted !== null && sameBytes(lastCompleted.sourcesDigest, sourcesDigest)) {
    return { status: 'skipped', published: 0, removed: 0, discarded: 0, sourcesDigest }
  }
  const onlyAdd =
    merged.silentNodes > 0 || merged.oldestDay === null || merged.oldestDay > cutoffDay(now, setting.retentionDays)
  const { groups, discarded: groupsDiscarded } = groupsToWrite(ctx, indexName, setting, merged.result)
  const dueByGroup = new Map<string, Map<string, number>>()
  for (const group of groups) {
    dueByGroup.set(group, await choose(ctx, indexName, setting, merged.result.groups[group] ?? []))
  }
  let published = 0
  let removed = 0
  const undo: UndoStep[] = []
  const created: string[] = []
  const bannedNow = (): Set<string> => new Set(ctx.host.view(indexName)?.state?.bannedQueries ?? [])
  try {
    for (const [group, due] of dueByGroup) {
      const changes = await ctx.withWriteLock(indexName, async () => {
        const name = await ensureSuggestionsIndex(ctx.host, indexName, group, created)
        return writeGroup(ctx.host, name, due, bannedNow(), onlyAdd, undo)
      })
      published += changes.published
      removed += changes.removed
    }
  } catch (error) {
    await ctx.withWriteLock(indexName, () => undoWrites(ctx.host, undo, bannedNow())).catch(() => undefined)
    for (const name of created) await ctx.host.engine.dropIndex(name).catch(() => undefined)
    throw error
  }
  return {
    status: 'completed',
    published,
    removed,
    discarded: merged.result.discarded + groupsDiscarded,
    sourcesDigest,
  }
}
