import { DAY_MS, HISTORY_SWEEP_INTERVAL_MS, MAX_TIMER_DELAY_MS, SCHEDULE_OFF } from './constants'
import { dayOf } from './day-store'
import { historyFileOf, listHistoryFolder, removeHistoryFolder, removeRestoreLeftovers } from './history-files'
import type { QuerySuggestionsRuntime } from './runtime'
import { latestMatchAtOrBefore, nextMatchAfter, parseSchedule } from './schedule'
import { resolveSetting } from './setting'

type Timer = ReturnType<typeof setTimeout>

function unrefTimer(timer: Timer): Timer {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

export class SuggestionTimers {
  private readonly runtime: QuerySuggestionsRuntime
  private readonly saves = new Map<string, Timer>()
  private readonly schedules = new Map<string, Timer>()
  private sweep: ReturnType<typeof setInterval> | null = null
  private midnight: Timer | null = null
  private stopped = false

  constructor(runtime: QuerySuggestionsRuntime) {
    this.runtime = runtime
  }

  saveSoon(indexName: string, intervalMs: number): void {
    if (this.stopped || this.saves.has(indexName)) return
    const timer = setTimeout(() => {
      this.saves.delete(indexName)
      void this.runtime
        .saveDay(indexName)
        .then(() => {
          if (this.runtime.days?.hasUnsaved(indexName) === true) this.saveSoon(indexName, intervalMs)
        })
        .catch(() => undefined)
    }, intervalMs)
    this.saves.set(indexName, unrefTimer(timer))
  }

  forgetSave(indexName: string): void {
    const timer = this.saves.get(indexName)
    if (timer !== undefined) clearTimeout(timer)
    this.saves.delete(indexName)
  }

  forgetIndex(indexName: string): void {
    this.forgetSave(indexName)
    const timer = this.schedules.get(indexName)
    if (timer !== undefined) clearTimeout(timer)
    this.schedules.delete(indexName)
  }

  async start(): Promise<void> {
    await removeRestoreLeftovers(this.runtime.host.files).catch(() => undefined)
    await this.sweepNow()
    this.sweep = setInterval(() => void this.sweepNow(), HISTORY_SWEEP_INTERVAL_MS)
    ;(this.sweep as { unref?: () => void }).unref?.()
    this.armMidnight()
    for (const indexName of this.runtime.host.indexNames()) {
      if (this.runtime.settingOf(indexName)?.enabled !== true) continue
      await this.startMissedBuild(indexName)
      this.rearm(indexName)
    }
  }

  async catchUpMissedBuilds(): Promise<void> {
    for (const indexName of this.runtime.host.indexNames()) {
      if (this.stopped) return
      if (this.runtime.settingOf(indexName)?.enabled === true) await this.startMissedBuild(indexName)
    }
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.saves.values()) clearTimeout(timer)
    for (const timer of this.schedules.values()) clearTimeout(timer)
    this.saves.clear()
    this.schedules.clear()
    if (this.sweep !== null) clearInterval(this.sweep)
    if (this.midnight !== null) clearTimeout(this.midnight)
    this.sweep = null
    this.midnight = null
  }

  nextBuildAt(indexName: string): number | null {
    const setting = this.runtime.settingOf(indexName)
    if (setting?.enabled !== true || this.runtime.scrambler === null) return null
    const resolved = resolveSetting(setting)
    if (resolved.schedule === SCHEDULE_OFF) return null
    const schedule = parseSchedule(resolved.schedule)
    return schedule === null ? null : nextMatchAfter(schedule, resolved.timeZone, Date.now())
  }

  rearm(indexName: string): void {
    const previous = this.schedules.get(indexName)
    if (previous !== undefined) clearTimeout(previous)
    this.schedules.delete(indexName)
    if (this.stopped) return
    const at = this.nextBuildAt(indexName)
    if (at !== null) this.arm(indexName, at)
  }

  private arm(indexName: string, at: number): void {
    const delay = Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_DELAY_MS)
    const timer = setTimeout(() => {
      this.schedules.delete(indexName)
      if (this.stopped) return
      if (Date.now() < at) {
        this.arm(indexName, at)
        return
      }
      this.startBuild(indexName, 'schedule')
      this.rearm(indexName)
    }, delay)
    this.schedules.set(indexName, unrefTimer(timer))
  }

  private startBuild(indexName: string, trigger: 'schedule' | 'missed'): void {
    if (!this.runtime.host.mayBuild()) return
    try {
      void this.runtime.builds.start(indexName, trigger).catch(() => undefined)
    } catch {}
  }

  private async startMissedBuild(indexName: string): Promise<void> {
    const setting = this.runtime.settingOf(indexName)
    if (setting === null) return
    const resolved = resolveSetting(setting)
    if (resolved.schedule === SCHEDULE_OFF) return
    const schedule = parseSchedule(resolved.schedule)
    if (schedule === null) return
    const latest = latestMatchAtOrBefore(schedule, resolved.timeZone, Date.now())
    if (latest === null) return
    const record = await this.runtime.host.readBuildRecord(indexName).catch(() => null)
    const completedSince =
      record !== null && (record.status === 'completed' || record.status === 'skipped') && record.startedAt >= latest
    if (!completedSince) this.startBuild(indexName, 'missed')
  }

  private armMidnight(): void {
    if (this.stopped) return
    const now = Date.now()
    const delay = Math.min(Math.floor(now / DAY_MS + 1) * DAY_MS - now, MAX_TIMER_DELAY_MS)
    this.midnight = unrefTimer(
      setTimeout(() => {
        this.midnight = null
        void this.retireDays().finally(() => this.armMidnight())
      }, delay),
    )
  }

  private async retireDays(): Promise<void> {
    const days = this.runtime.days
    if (days === null) return
    const today = dayOf(Date.now())
    for (const indexName of days.indexes()) await days.retire(indexName, today).catch(() => undefined)
  }

  async sweepNow(): Promise<void> {
    const { host } = this.runtime
    const today = Date.now()
    for (const indexName of host.indexNames()) {
      const setting = this.runtime.settingOf(indexName)
      try {
        if (setting?.enabled !== true) {
          if (host.view(indexName)?.state?.querySuggestionsSource === undefined) {
            await removeHistoryFolder(host.files, indexName)
          }
          continue
        }
        const cutoff = dayOf(today - resolveSetting(setting).retentionDays * DAY_MS)
        for (const key of await listHistoryFolder(host.files, indexName)) {
          const file = historyFileOf(indexName, key)
          if (file !== null && file.day < cutoff) await host.files.remove(key)
        }
      } catch {}
    }
  }
}
