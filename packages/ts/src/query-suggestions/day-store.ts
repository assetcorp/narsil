import { DAY_MS, SCRAMBLED_ID_BYTES } from './constants'
import { encodeCountsFile, openCountsFile } from './counts-file'
import { type CountOutcome, DayCounts, type DayLimits } from './day-counts'
import { dayFileKey } from './history-files'
import { HistoryGroups } from './history-groups'
import type { SuggestionsHost } from './host'
import type { PersonScrambler } from './scramble'
import type { ResolvedSetting } from './setting'

export function dayOf(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10)
}

function limitsOf(setting: ResolvedSetting): DayLimits {
  return {
    minPeople: setting.minPeople,
    maxPhrasesPerDay: setting.maxPhrasesPerDay,
    maxPhrasesPerPerson: setting.maxPhrasesPerPerson,
    maxPeoplePerDay: setting.maxPeoplePerDay,
    maxGroups: setting.maxGroups,
  }
}

function sameLimits(left: DayLimits, right: DayLimits): boolean {
  return (
    left.minPeople === right.minPeople &&
    left.maxPhrasesPerDay === right.maxPhrasesPerDay &&
    left.maxPhrasesPerPerson === right.maxPhrasesPerPerson &&
    left.maxPeoplePerDay === right.maxPeoplePerDay &&
    left.maxGroups === right.maxGroups
  )
}

export interface CountRequest {
  group: string
  phrase: string
  person: string
  groupAllowed(knownGroups: Set<string>): boolean
  stillEnabled(): boolean
  isBanned(): boolean
}

export class DayStore {
  private readonly host: SuggestionsHost
  private readonly scrambler: PersonScrambler
  private readonly history: HistoryGroups
  private readonly days = new Map<string, DayCounts>()
  private readonly unsavedDays = new Map<string, DayCounts[]>()
  private readonly turns = new Map<string, Promise<unknown>>()
  private readonly warnedLimits = new Map<string, string>()
  private readonly generations = new Map<string, number>()

  constructor(host: SuggestionsHost, scrambler: PersonScrambler) {
    this.host = host
    this.scrambler = scrambler
    this.history = new HistoryGroups(host, scrambler.fingerprint)
  }

  hasUnsaved(indexName: string): boolean {
    return this.days.get(indexName)?.isChanged === true || this.unsavedDays.has(indexName)
  }

  indexes(): string[] {
    return [...new Set([...this.days.keys(), ...this.unsavedDays.keys()])]
  }

  inTurn<T>(indexName: string, work: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(indexName) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.catch(() => undefined)
    this.turns.set(indexName, settled)
    void settled.then(() => {
      if (this.turns.get(indexName) === settled) this.turns.delete(indexName)
    })
    return next
  }

  count(
    indexName: string,
    setting: ResolvedSetting,
    now: number,
    request: CountRequest,
  ): Promise<CountOutcome | 'banned' | null> {
    return this.inTurn(indexName, async (): Promise<CountOutcome | 'banned' | null> => {
      if (!request.stillEnabled()) return null
      if (request.isBanned()) return 'banned'
      const counts = await this.currentDay(indexName, setting, now)
      const groupAllowed =
        counts.hasGroup(request.group) ||
        request.groupAllowed(await this.knownGroups(indexName, counts, dayOf(now - setting.retentionDays * DAY_MS)))
      const outcome = counts.count(request.group, request.phrase, this.scrambler.scramble(request.person), groupAllowed)
      if (outcome === 'phrase-limit' || outcome === 'people-limit') this.warnLimit(indexName, counts.day, outcome)
      return outcome
    })
  }

  save(indexName: string): Promise<void> {
    return this.inTurn(indexName, () => this.saveNow(indexName))
  }

  retire(indexName: string, today: string): Promise<void> {
    return this.inTurn(indexName, async () => {
      await this.saveNow(indexName)
      const counts = this.days.get(indexName)
      if (counts === undefined || counts.day >= today || counts.isChanged) return
      this.history.note(indexName, counts.day, counts.groupNames)
      this.days.delete(indexName)
    })
  }

  forgetHistoryGroups(indexName: string): Promise<void> {
    return this.inTurn(indexName, async () => this.history.forget(indexName))
  }

  discard(indexName: string): Promise<void> {
    return this.inTurn(indexName, async () => {
      this.days.delete(indexName)
      this.unsavedDays.delete(indexName)
      this.history.forget(indexName)
      this.warnedLimits.delete(indexName)
      this.generations.set(indexName, (this.generations.get(indexName) ?? 0) + 1)
    })
  }

  private async knownGroups(indexName: string, counts: DayCounts, cutoff: string): Promise<Set<string>> {
    const known = new Set(counts.groupNames)
    for (const unsaved of this.unsavedDays.get(indexName) ?? []) {
      for (const group of unsaved.groupNames) known.add(group)
    }
    for (const group of await this.history.of(indexName, cutoff)) known.add(group)
    return known
  }

  private warnLimit(indexName: string, day: string, reason: 'phrase-limit' | 'people-limit'): void {
    const mark = `${day}:${reason}`
    const warned = this.warnedLimits.get(indexName) ?? ''
    if (warned.split('|').includes(mark)) return
    this.warnedLimits.set(indexName, warned === '' ? mark : `${warned}|${mark}`)
    this.host.emit('querySuggestionsWarning', { indexName, reason })
  }

  private async currentDay(indexName: string, setting: ResolvedSetting, now: number): Promise<DayCounts> {
    const day = dayOf(now)
    const limits = limitsOf(setting)
    const current = this.days.get(indexName)
    if (current !== undefined && current.day === day && sameLimits(current.limits, limits)) return current
    if (current !== undefined) {
      await this.saveNow(indexName)
      if (current.isChanged) {
        if (current.day === day) return current
        this.unsavedDays.set(indexName, [...(this.unsavedDays.get(indexName) ?? []), current])
      }
      this.history.note(indexName, current.day, current.groupNames)
      this.days.delete(indexName)
    }
    const loaded = await this.load(indexName, day, limits)
    this.days.set(indexName, loaded)
    return loaded
  }

  private async load(indexName: string, day: string, limits: DayLimits): Promise<DayCounts> {
    const counts = new DayCounts(day, limits)
    const key = dayFileKey(indexName, day)
    const bytes = await this.host.files.read(key)
    if (bytes === null) return counts
    if (bytes === 'too-long') {
      this.host.emit('querySuggestionsWarning', { indexName, reason: 'damaged-file', file: key })
      return counts
    }
    const opened = await openCountsFile(bytes, day, this.scrambler.fingerprint)
    if (opened.kind !== 'counts') {
      const reason = opened.kind === 'other-key' ? 'other-key' : 'damaged-file'
      this.host.emit('querySuggestionsWarning', { indexName, reason, file: key })
      return counts
    }
    if (this.host.clustered && opened.indexUuid !== (this.host.view(indexName)?.indexUuid ?? null)) return counts
    opened.visit((group, phrase, count, people) => {
      const ids = new Uint8Array(people.offsets.length * SCRAMBLED_ID_BYTES)
      people.offsets.forEach((offset, i) => {
        ids.set(people.source.subarray(offset, offset + SCRAMBLED_ID_BYTES), i * SCRAMBLED_ID_BYTES)
      })
      counts.restorePhrase(group, phrase, count, ids, people.offsets.length)
    })
    return counts
  }

  private async saveNow(indexName: string): Promise<void> {
    const unsaved = this.unsavedDays.get(indexName)
    if (unsaved !== undefined) {
      const stillUnsaved: DayCounts[] = []
      for (const counts of unsaved) {
        await this.write(indexName, counts)
        if (counts.isChanged) stillUnsaved.push(counts)
      }
      if (this.unsavedDays.get(indexName) === unsaved) {
        if (stillUnsaved.length === 0) this.unsavedDays.delete(indexName)
        else this.unsavedDays.set(indexName, stillUnsaved)
      }
    }
    const counts = this.days.get(indexName)
    if (counts !== undefined) await this.write(indexName, counts)
  }

  private async write(indexName: string, counts: DayCounts): Promise<void> {
    if (!counts.isChanged) return
    const generation = this.generations.get(indexName) ?? 0
    const view = this.host.view(indexName)
    const bytes = encodeCountsFile(counts, {
      fingerprint: this.scrambler.fingerprint,
      savedAt: Date.now(),
      indexUuid: this.host.clustered ? (view?.indexUuid ?? null) : null,
    })
    counts.markSaved()
    try {
      if ((this.generations.get(indexName) ?? 0) !== generation) return
      await this.host.files.write(dayFileKey(indexName, counts.day), bytes)
    } catch (error) {
      counts.markChanged()
      this.host.emit('querySuggestionsWarning', {
        indexName,
        reason: 'save-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
