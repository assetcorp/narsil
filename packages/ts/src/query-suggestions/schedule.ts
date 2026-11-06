import { DAY_MS, MAX_SCHEDULE_LENGTH, SCHEDULE_LOOKAHEAD_DAYS } from './constants'

export interface Schedule {
  minutes: boolean[]
  hours: boolean[]
  daysOfMonth: boolean[]
  months: boolean[]
  daysOfWeek: boolean[]
  dayOfMonthAny: boolean
  dayOfWeekAny: boolean
}

interface FieldRange {
  min: number
  max: number
}

const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
]
const MINUTE_MS = 60_000
const NUMBER = /^\d{1,2}$/

function parseNumber(text: string, range: FieldRange): number | null {
  if (!NUMBER.test(text)) return null
  const value = Number(text)
  return value >= range.min && value <= range.max ? value : null
}

function parseField(text: string, range: FieldRange): boolean[] | null {
  const allowed = new Array<boolean>(range.max + 1).fill(false)
  for (const part of text.split(',')) {
    const [base, stepText, ...extra] = part.split('/')
    if (base === undefined || extra.length > 0) return null
    let step = 1
    if (stepText !== undefined) {
      if (!NUMBER.test(stepText) || Number(stepText) < 1) return null
      step = Number(stepText)
    }
    let start: number
    let end: number
    if (base === '*') {
      start = range.min
      end = range.max
    } else {
      const bounds = base.split('-')
      if (bounds.length > 2) return null
      const first = parseNumber(bounds[0] ?? '', range)
      if (first === null) return null
      start = first
      if (bounds.length === 2) {
        const last = parseNumber(bounds[1] ?? '', range)
        if (last === null || last < first) return null
        end = last
      } else end = stepText === undefined ? first : range.max
    }
    for (let value = start; value <= end; value += step) allowed[value] = true
  }
  return allowed
}

export function parseSchedule(expression: string): Schedule | null {
  if (expression.length > MAX_SCHEDULE_LENGTH) return null
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== FIELD_RANGES.length) return null
  const parsed: boolean[][] = []
  for (let i = 0; i < fields.length; i++) {
    const field = parseField(fields[i] ?? '', FIELD_RANGES[i])
    if (field === null) return null
    parsed.push(field)
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthAny: fields[2] === '*',
    dayOfWeekAny: fields[4] === '*',
  }
}

interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

function wallTimeAt(instant: number, timeZone: string): WallTime {
  const parts: Record<string, number> = {}
  for (const part of formatterOf(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute }
}

function wallAsUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
}

function instantOf(wall: WallTime, timeZone: string): number | null {
  const target = wallAsUtc(wall)
  let guess = target
  for (let attempt = 0; attempt < 3; attempt++) {
    const offset = wallAsUtc(wallTimeAt(guess, timeZone)) - guess
    guess = target - offset
  }
  const landed = wallTimeAt(guess, timeZone)
  return wallAsUtc(landed) === target ? guess : null
}

function dayMatches(schedule: Schedule, dayStartUtc: number): boolean {
  const date = new Date(dayStartUtc)
  if (!schedule.months[date.getUTCMonth() + 1]) return false
  const monthDay = schedule.daysOfMonth[date.getUTCDate()] === true
  const weekDay = schedule.daysOfWeek[date.getUTCDay()] === true
  if (!schedule.dayOfMonthAny && !schedule.dayOfWeekAny) return monthDay || weekDay
  return monthDay && weekDay
}

function matchesOfDay(schedule: Schedule, dayStartUtc: number, timeZone: string): number[] {
  const date = new Date(dayStartUtc)
  const instants: number[] = []
  for (let hour = 0; hour < 24; hour++) {
    if (!schedule.hours[hour]) continue
    for (let minute = 0; minute < 60; minute++) {
      if (!schedule.minutes[minute]) continue
      const wall = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute }
      const instant = instantOf(wall, timeZone)
      if (instant !== null) instants.push(instant)
    }
  }
  return instants
}

function localDayStart(instant: number, timeZone: string): number {
  const wall = wallTimeAt(instant, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day)
}

export function nextMatchAfter(schedule: Schedule, timeZone: string, after: number): number | null {
  const firstDay = localDayStart(after, timeZone)
  for (let day = 0; day <= SCHEDULE_LOOKAHEAD_DAYS; day++) {
    const dayStart = firstDay + day * DAY_MS
    if (!dayMatches(schedule, dayStart)) continue
    for (const instant of matchesOfDay(schedule, dayStart, timeZone)) {
      if (instant > after) return instant
    }
  }
  return null
}

export function latestMatchAtOrBefore(schedule: Schedule, timeZone: string, at: number): number | null {
  const firstDay = localDayStart(at, timeZone)
  for (let day = 0; day <= SCHEDULE_LOOKAHEAD_DAYS; day++) {
    const dayStart = firstDay - day * DAY_MS
    if (!dayMatches(schedule, dayStart)) continue
    const instants = matchesOfDay(schedule, dayStart, timeZone)
    for (let i = instants.length - 1; i >= 0; i--) {
      if (instants[i] <= at) return instants[i]
    }
  }
  return null
}

export function minuteFloor(instant: number): number {
  return Math.floor(instant / MINUTE_MS) * MINUTE_MS
}
