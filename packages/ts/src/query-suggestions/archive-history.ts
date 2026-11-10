import {
  attachedRuntimeOf,
  historyFileOf,
  historyFilesOf,
  listHistoryFolder,
  QUERY_HISTORY_ARCHIVE_PREFIX,
} from '#platform/storage-host'
import type { EngineCore } from '../engine/core'
import type { ArchiveEntry } from '../persistence/archive/write'
import type { HistoryFileName } from './history-files'

function inDayOrder(left: HistoryFileName, right: HistoryFileName): number {
  if (left.day !== right.day) return left.day < right.day ? -1 : 1
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
}

export async function* historyArchiveEntries(core: EngineCore, indexName: string): AsyncGenerator<ArchiveEntry> {
  const runtime = attachedRuntimeOf(core)
  const files = runtime?.host.files ?? historyFilesOf(core.durability?.manager.historyStorage?.() ?? null)
  await runtime?.saveDay(indexName)
  const names: HistoryFileName[] = []
  for (const key of await listHistoryFolder(files, indexName)) {
    const name = historyFileOf(indexName, key)
    if (name !== null) names.push(name)
  }
  names.sort(inDayOrder)
  let position = 0
  for (const name of names) {
    const bytes = await files.read(name.key)
    if (bytes === null || bytes === 'too-long') continue
    yield { name: `${QUERY_HISTORY_ARCHIVE_PREFIX}${position}`, bytes }
    position += 1
  }
}
