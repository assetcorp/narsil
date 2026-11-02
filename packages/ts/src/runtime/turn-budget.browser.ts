import { UI_THREAD_TURN_BUDGET_MS } from './constants'

let turnStartedAt = performance.now()

export function turnIsSpent(): boolean {
  return performance.now() - turnStartedAt >= UI_THREAD_TURN_BUDGET_MS
}

export function turnStarted(): void {
  turnStartedAt = performance.now()
}

function nextTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

export async function yieldTurn(): Promise<void> {
  await nextTask()
  turnStarted()
}
