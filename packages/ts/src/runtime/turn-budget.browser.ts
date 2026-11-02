import { UI_THREAD_TURN_BUDGET_MS } from './constants'

let turnStartedAt = performance.now()

export function turnIsSpent(): boolean {
  return performance.now() - turnStartedAt >= UI_THREAD_TURN_BUDGET_MS
}

export function turnStarted(): void {
  turnStartedAt = performance.now()
}

export async function yieldTurn(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  await (scheduler?.yield
    ? scheduler.yield()
    : new Promise<void>(resolve => {
        const { port1, port2 } = new MessageChannel()
        port1.onmessage = () => {
          port1.close()
          resolve()
        }
        port2.postMessage(null)
      }))
  turnStarted()
}
