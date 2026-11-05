import type { RestoredHistorySink } from '../engine/snapshot/restore-setup'
import type { QuerySuggestionsSetting } from '../types/query-suggestions'
import { DAY_MS, QUERY_HISTORY_ARCHIVE_PREFIX } from './constants'
import { openCountsFile } from './counts-file'
import { dayOf } from './day-store'
import { restoredFileKey, restoreStagingPrefix } from './history-files'
import type { QuerySuggestionsRuntime } from './runtime'
import { resolveSetting } from './setting'

interface StagedFile {
  key: string
  day: string
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let length = 0
  for await (const chunk of chunks) {
    parts.push(chunk)
    length += chunk.byteLength
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

export class RestoredHistory implements RestoredHistorySink {
  private readonly runtime: QuerySuggestionsRuntime
  private readonly indexName: string
  private readonly cutoff: string
  private readonly prefix = restoreStagingPrefix()
  private readonly staged: StagedFile[] = []
  private received = 0

  constructor(runtime: QuerySuggestionsRuntime, indexName: string, setting: QuerySuggestionsSetting) {
    this.runtime = runtime
    this.indexName = indexName
    this.cutoff = dayOf(Date.now() - resolveSetting(setting).retentionDays * DAY_MS)
  }

  async add(chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const position = this.received
    this.received += 1
    const bytes = await collect(chunks)
    const scrambler = this.runtime.scrambler
    if (scrambler === null) return
    const opened = await openCountsFile(bytes, null, scrambler.fingerprint)
    if (opened.kind !== 'counts') {
      this.runtime.host.emit('querySuggestionsWarning', {
        indexName: this.indexName,
        reason: opened.kind === 'other-key' ? 'other-key' : 'damaged-file',
        file: `${QUERY_HISTORY_ARCHIVE_PREFIX}${position}`,
      })
      return
    }
    if (opened.day < this.cutoff) return
    const key = `${this.prefix}${position}.nrsl`
    const indexUuid = this.runtime.host.clustered ? (this.runtime.host.view(this.indexName)?.indexUuid ?? null) : null
    await this.runtime.host.files.write(key, opened.withIndexUuid(indexUuid, opened.savedAt))
    this.staged.push({ key, day: opened.day })
  }

  async commit(): Promise<void> {
    if (this.received === 0) return
    const { files } = this.runtime.host
    await this.runtime.discardHistory(this.indexName)
    const sequences = new Map<string, number>()
    const ordered = [...this.staged].sort((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : 0))
    for (const file of ordered) {
      const bytes = await files.read(file.key)
      if (bytes instanceof Uint8Array) {
        const sequence = sequences.get(file.day) ?? 0
        sequences.set(file.day, sequence + 1)
        await files.write(restoredFileKey(this.indexName, file.day, sequence), bytes)
      }
      await files.remove(file.key)
    }
    this.staged.length = 0
    await this.runtime.days?.forgetHistoryGroups(this.indexName)
  }

  async abandon(): Promise<void> {
    for (const file of this.staged) await this.runtime.host.files.remove(file.key)
    this.staged.length = 0
  }
}
