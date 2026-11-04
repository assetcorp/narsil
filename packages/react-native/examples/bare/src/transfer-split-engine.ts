import { scheduleOnRN } from 'react-native-worklets'

export interface EngineReceipt {
  parts: number
  items: number
  workMs: number
  firstStartedAt: number
  lastEndedAt: number
  heldUntil: number
  error: string | null
}

function emptyReceipt(): EngineReceipt {
  return { parts: 0, items: 0, workMs: 0, firstStartedAt: 0, lastEndedAt: 0, heldUntil: 0, error: null }
}

let receipt: EngineReceipt = emptyReceipt()

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return String(error)
  } catch {
    return 'an error that has no text'
  }
}

function noteFailure(step: string, error: unknown): void {
  if (receipt.error === null) receipt.error = `${step} threw ${describe(error)}`
}

export function resetReceipt(): void {
  receipt = emptyReceipt()
}

export function holdEngine(ms: number): void {
  try {
    const endsAt = performance.now() + ms
    while (performance.now() < endsAt) {}
    receipt.heldUntil = performance.now()
  } catch (error) {
    noteFailure('holding the engine', error)
  }
}

export function receivePart(part: unknown, isText: boolean): void {
  try {
    const startedAt = performance.now()
    if (receipt.parts === 0) receipt.firstStartedAt = startedAt
    const items: unknown = isText ? JSON.parse(part as string) : part
    receipt.items += Array.isArray(items) ? items.length : 0
    receipt.parts += 1
    receipt.lastEndedAt = performance.now()
    receipt.workMs += receipt.lastEndedAt - startedAt
  } catch (error) {
    noteFailure(isText ? 'parsing a part' : 'receiving a part', error)
  }
}

export function reportReceipt(done: (engine: EngineReceipt) => void): void {
  try {
    scheduleOnRN(done, { ...receipt })
  } catch (error) {
    noteFailure('reporting the receipt', error)
    try {
      scheduleOnRN(done, { ...emptyReceipt(), error: receipt.error })
    } catch {}
  }
}
