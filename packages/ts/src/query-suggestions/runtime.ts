import { ErrorCodes, NarsilError } from '../errors'
import { loadDigest } from '../persistence/digest-code'
import type { QuerySuggestionsSetting, RecordedQuery, RecordQueryResult } from '../types/query-suggestions'
import { BuildRunner } from './build-runner'
import { MIN_KEY_BYTES } from './constants'
import { DayStore, dayOf } from './day-store'
import { removeHistoryFolder } from './history-files'
import type { SuggestionsHost } from './host'
import { acceptedPhrase, isGroup, isPerson } from './phrase'
import { RestoredHistory } from './restored-history'
import { createPersonScrambler, type PersonScrambler } from './scramble'
import { type ResolvedSetting, resolveSetting } from './setting'
import { markedSuggestionIndexes } from './suggestions-writer'
import { SuggestionTimers } from './timers'

export function keyBytesOf(key: string | Uint8Array): Uint8Array {
  const bytes = typeof key === 'string' ? new TextEncoder().encode(key) : new Uint8Array(key)
  if (bytes.byteLength < MIN_KEY_BYTES) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The query suggestions key must hold at least ${MIN_KEY_BYTES} bytes, and it holds ${bytes.byteLength}`,
      { bytes: bytes.byteLength },
    )
  }
  return bytes
}

function notFound(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, { indexName })
}

export function notEnabled(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.QUERY_SUGGESTIONS_NOT_ENABLED,
    `Index "${indexName}" has popular query suggestions off`,
    { indexName },
  )
}

export async function createQuerySuggestionsRuntime(
  host: SuggestionsHost,
  key: Uint8Array | null,
): Promise<QuerySuggestionsRuntime> {
  const scrambler = key === null ? null : createPersonScrambler(key, await loadDigest())
  return new QuerySuggestionsRuntime(host, scrambler)
}

export class QuerySuggestionsRuntime {
  readonly host: SuggestionsHost
  readonly scrambler: PersonScrambler | null
  readonly days: DayStore | null
  readonly builds: BuildRunner
  readonly timers: SuggestionTimers
  private readonly locks = new Map<string, Promise<unknown>>()
  private stopping = false

  constructor(host: SuggestionsHost, scrambler: PersonScrambler | null) {
    this.host = host
    this.scrambler = scrambler
    this.days = this.scrambler === null ? null : new DayStore(host, this.scrambler)
    this.builds = new BuildRunner(this)
    this.timers = new SuggestionTimers(this)
  }

  get isStopping(): boolean {
    return this.stopping
  }

  enabledSetting(indexName: string): ResolvedSetting {
    const view = this.host.view(indexName)
    if (view === null) throw notFound(indexName)
    const setting = view.state?.querySuggestions
    if (setting === undefined || !setting.enabled) throw notEnabled(indexName)
    return resolveSetting(setting)
  }

  settingOf(indexName: string): QuerySuggestionsSetting | null {
    return this.host.view(indexName)?.state?.querySuggestions ?? null
  }

  withWriteLock<T>(indexName: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(indexName) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.catch(() => undefined)
    this.locks.set(indexName, settled)
    void settled.then(() => {
      if (this.locks.get(indexName) === settled) this.locks.delete(indexName)
    })
    return next
  }

  async saveDay(indexName: string): Promise<void> {
    await this.days?.save(indexName)
  }

  private groupAllowed(indexName: string, group: string, maxGroups: number, known: Set<string>): boolean {
    for (const marked of markedSuggestionIndexes(this.host, indexName).keys()) known.add(marked)
    return known.has(group) || known.size < maxGroups
  }

  async record(indexName: string, input: RecordedQuery): Promise<RecordQueryResult> {
    if (this.stopping) throw new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'The engine is shutting down')
    const setting = this.enabledSetting(indexName)
    if (this.days === null) return { recorded: false, outcome: 'no-key' }
    const { query, person, group } = (input ?? {}) as Partial<RecordedQuery>
    if (typeof query !== 'string' || !isPerson(person) || !isGroup(group)) {
      return { recorded: false, outcome: 'invalid' }
    }
    const phrase = acceptedPhrase(query, setting)
    if (phrase === null) return { recorded: false, outcome: 'invalid' }
    const isBanned = (): boolean => (this.host.view(indexName)?.state?.bannedQueries ?? []).includes(phrase)
    if (isBanned()) return { recorded: false, outcome: 'banned' }
    const outcome = await this.days.count(indexName, setting, Date.now(), {
      group,
      phrase,
      person,
      groupAllowed: known => this.groupAllowed(indexName, group, setting.maxGroups, known),
      stillEnabled: () => this.settingOf(indexName)?.enabled === true,
      isBanned,
    })
    if (outcome === null) throw notEnabled(indexName)
    if (outcome === 'recorded') this.timers.saveSoon(indexName, setting.saveIntervalMs)
    return { recorded: outcome === 'recorded', outcome }
  }

  restoredHistory(indexName: string, setting: QuerySuggestionsSetting | undefined): RestoredHistory | null {
    if (setting?.enabled !== true || this.scrambler === null) return null
    return new RestoredHistory(this, indexName, setting)
  }

  async discardHistory(indexName: string): Promise<void> {
    this.timers.forgetSave(indexName)
    await this.days?.discard(indexName)
    await removeHistoryFolder(this.host.files, indexName)
  }

  async onDrop(indexName: string): Promise<void> {
    this.timers.forgetIndex(indexName)
    this.builds.forget(indexName)
    await this.days?.discard(indexName)
    await removeHistoryFolder(this.host.files, indexName).catch(() => undefined)
  }

  warnWithoutKey(): void {
    if (this.scrambler !== null) return
    for (const indexName of this.host.indexNames()) {
      if (this.settingOf(indexName)?.enabled === true) {
        this.host.emit('querySuggestionsWarning', { indexName, reason: 'no-key' })
      }
    }
  }

  async start(): Promise<void> {
    this.warnWithoutKey()
    if (this.scrambler === null) {
      await this.timers.sweepNow()
      return
    }
    await this.timers.start()
  }

  settingChanged(indexName: string): void {
    this.timers.rearm(indexName)
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.timers.stop()
    await this.builds.settled()
    if (this.days === null) return
    for (const indexName of this.days.indexes()) await this.days.save(indexName)
  }

  today(): string {
    return dayOf(Date.now())
  }
}
