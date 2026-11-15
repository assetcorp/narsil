import { MAX_LIST_ITEMS, VARIABLE_PREFIX } from './constants'

export type Environment = Readonly<Record<string, string | undefined>>

export class SettingError extends Error {
  constructor(
    readonly variable: string,
    readonly rule: string,
  ) {
    super(`${variable} ${rule}`)
    this.name = 'SettingError'
  }
}

const WHOLE_NUMBER = /^[0-9]+$/
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/

interface WholeNumberRange {
  min: number
  max?: number
}

function rangeRule(range: WholeNumberRange): string {
  if (range.max === undefined) return `must be a whole number of at least ${range.min}`
  return `must be a whole number from ${range.min} to ${range.max}`
}

export class VariableReader {
  private readonly consulted = new Set<string>()

  constructor(private readonly env: Environment) {}

  text(name: string): string | undefined {
    this.consulted.add(name)
    const value = this.env[name]
    return value === undefined || value.length === 0 ? undefined : value
  }

  wholeNumber(name: string, range: WholeNumberRange): number | undefined {
    const raw = this.text(name)
    if (raw === undefined) return undefined
    if (!WHOLE_NUMBER.test(raw)) throw new SettingError(name, rangeRule(range))
    const value = Number(raw)
    const max = range.max ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(value) || value < range.min || value > max) {
      throw new SettingError(name, rangeRule({ min: range.min, max }))
    }
    return value
  }

  decimal(name: string, min: number, max: number): number | undefined {
    const raw = this.text(name)
    if (raw === undefined) return undefined
    const value = DECIMAL.test(raw) ? Number(raw) : Number.NaN
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new SettingError(name, `must be a decimal from ${min} to ${max}`)
    }
    return value
  }

  boolean(name: string): boolean | undefined {
    const raw = this.text(name)
    if (raw === undefined) return undefined
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new SettingError(name, 'must be true or false')
  }

  list(name: string): string[] | undefined {
    const raw = this.text(name)
    if (raw === undefined) return undefined
    const items = raw.split(',').map(item => item.trim())
    if (items.some(item => item.length === 0)) {
      throw new SettingError(name, 'must be items separated by commas, with no empty item')
    }
    if (items.length > MAX_LIST_ITEMS) throw new SettingError(name, `must hold at most ${MAX_LIST_ITEMS} items`)
    return items
  }

  oneOf<T extends string>(name: string, choices: readonly T[]): T | undefined {
    const raw = this.text(name)
    if (raw === undefined) return undefined
    const choice = choices.find(candidate => candidate === raw)
    if (choice === undefined) throw new SettingError(name, `must be ${choices.join(' or ')}`)
    return choice
  }

  isSet(name: string): boolean {
    return this.text(name) !== undefined
  }

  unconsultedNames(): string[] {
    return Object.keys(this.env)
      .filter(name => name.startsWith(VARIABLE_PREFIX) && !this.consulted.has(name))
      .sort()
  }
}
