import { openCountsFile } from './counts-file'
import { historyFileOf, listHistoryFolder } from './history-files'
import type { SuggestionsHost } from './host'

interface HeldGroups {
  cutoff: string
  newestDay: Map<string, string>
}

export class HistoryGroups {
  private readonly host: SuggestionsHost
  private readonly fingerprint: Uint8Array
  private readonly held = new Map<string, HeldGroups>()

  constructor(host: SuggestionsHost, fingerprint: Uint8Array) {
    this.host = host
    this.fingerprint = fingerprint
  }

  async of(indexName: string, cutoff: string): Promise<Iterable<string>> {
    const held = this.held.get(indexName)
    if (held !== undefined && held.cutoff <= cutoff) {
      if (held.cutoff < cutoff) {
        for (const [group, day] of held.newestDay) if (day < cutoff) held.newestDay.delete(group)
        held.cutoff = cutoff
      }
      return held.newestDay.keys()
    }
    const newestDay = await this.load(indexName, cutoff)
    this.held.set(indexName, { cutoff, newestDay })
    return newestDay.keys()
  }

  note(indexName: string, day: string, groups: Iterable<string>): void {
    const held = this.held.get(indexName)
    if (held === undefined || day < held.cutoff) return
    for (const group of groups) {
      const newest = held.newestDay.get(group)
      if (newest === undefined || newest < day) held.newestDay.set(group, day)
    }
  }

  forget(indexName: string): void {
    this.held.delete(indexName)
  }

  private async load(indexName: string, cutoff: string): Promise<Map<string, string>> {
    const newestDay = new Map<string, string>()
    const expectedUuid = this.host.view(indexName)?.indexUuid ?? null
    for (const key of await listHistoryFolder(this.host.files, indexName)) {
      const file = historyFileOf(indexName, key)
      if (file === null || file.day < cutoff) continue
      const bytes = await this.host.files.read(key)
      if (!(bytes instanceof Uint8Array)) continue
      const opened = await openCountsFile(bytes, file.day, this.fingerprint)
      if (opened.kind !== 'counts') continue
      if (this.host.clustered && (opened.indexUuid === null || opened.indexUuid !== expectedUuid)) continue
      for (const group of opened.groupNames()) {
        const newest = newestDay.get(group)
        if (newest === undefined || newest < file.day) newestDay.set(group, file.day)
      }
    }
    return newestDay
  }
}
