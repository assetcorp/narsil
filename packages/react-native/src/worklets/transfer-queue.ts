import {
  WORKLET_TRANSFER_FIRST_PART_ITEMS,
  WORKLET_TRANSFER_LARGEST_PART_ITEMS,
  WORKLET_TRANSFER_PART_TARGET_MS,
  WORKLET_TRANSFER_TURN_BUDGET_MS,
} from '../constants'
import { afterAppTurn } from './app-turns'

interface Transfer {
  sendNextStep(): boolean
  fail(error: unknown): void
}

export interface CallSends {
  sendPart(argIndex: number, items: readonly unknown[]): void
  sendCall(args: readonly unknown[], partedArgs: readonly number[]): void
  dropParts(): void
  fail(error: unknown): void
}

const waiting: Transfer[] = []
let sending = false

function sendWaiting(): void {
  sending = true
  const turnStarted = performance.now()
  while (waiting.length > 0) {
    const transfer = waiting[0]
    let finished: boolean
    try {
      finished = transfer.sendNextStep()
    } catch (error) {
      finished = true
      transfer.fail(error)
    }
    if (finished) waiting.shift()
    if (waiting.length > 0 && performance.now() - turnStarted >= WORKLET_TRANSFER_TURN_BUDGET_MS) {
      afterAppTurn(sendWaiting)
      return
    }
  }
  sending = false
}

function enqueue(transfer: Transfer): void {
  waiting.push(transfer)
  if (!sending) sendWaiting()
}

function nextPartItems(sentItems: number, elapsedMs: number): number {
  const perItemMs = elapsedMs / sentItems
  if (perItemMs <= 0) return WORKLET_TRANSFER_LARGEST_PART_ITEMS
  const fitting = Math.floor(WORKLET_TRANSFER_PART_TARGET_MS / perItemMs)
  return Math.min(WORKLET_TRANSFER_LARGEST_PART_ITEMS, Math.max(1, fitting))
}

export function enqueueCall(args: readonly unknown[], sends: CallSends): void {
  const partedArgs: number[] = []
  for (const [index, value] of args.entries()) {
    if (Array.isArray(value) && value.length > WORKLET_TRANSFER_FIRST_PART_ITEMS) partedArgs.push(index)
  }
  let argPosition = 0
  let offset = 0
  let partItems = WORKLET_TRANSFER_FIRST_PART_ITEMS
  let sentAnyPart = false

  function sendNextStep(): boolean {
    const argIndex = partedArgs[argPosition]
    if (argIndex === undefined) {
      const remaining = args.map((value, index) => (partedArgs.includes(index) ? null : value))
      sends.sendCall(remaining, partedArgs)
      return true
    }
    const items = args[argIndex] as readonly unknown[]
    const part = items.slice(offset, offset + partItems)
    const started = performance.now()
    sends.sendPart(argIndex, part)
    sentAnyPart = true
    partItems = nextPartItems(part.length, performance.now() - started)
    offset += part.length
    if (offset >= items.length) {
      argPosition += 1
      offset = 0
    }
    return false
  }

  function fail(error: unknown): void {
    if (sentAnyPart) {
      try {
        sends.dropParts()
      } catch {}
    }
    sends.fail(error)
  }

  enqueue({ sendNextStep, fail })
}
