import type { NarsilClient } from '../../client/client'
import type { RequestOptions } from '../../client/options'
import type { Narsil } from '../../narsil'
import { BACKOFF_DOUBLINGS_LIMIT } from './constants'
import type { QueueMirror } from './queue'
import type { Serial } from './stores/serial'
import type { DeviceSyncOptions, DeviceSyncStore } from './types'

export interface Changes {
  notify(): void
  next(): Promise<void>
}

export function createChanges(): Changes {
  let waiters: Array<() => void> = []
  return {
    notify() {
      const woken = waiters
      waiters = []
      for (const wake of woken) wake()
    },
    next() {
      return new Promise(resolve => waiters.push(resolve))
    },
  }
}

export interface DeviceContext {
  options: DeviceSyncOptions
  engine: Narsil
  indexName: string
  store: DeviceSyncStore
  client: NarsilClient
  work: Serial
  queue: QueueMirror
  changes: Changes
  report(error: unknown): void
  credential(): Promise<string | null>
  requestOptions(): Promise<RequestOptions>
  makeDurable(): Promise<void>
  stopped(): boolean
  pause(delayMs: number): Promise<void>
}

export function backoffDelayMs(attempt: number, minimumMs: number, maximumMs: number): number {
  const ceiling = Math.min(maximumMs, minimumMs * 2 ** Math.min(attempt, BACKOFF_DOUBLINGS_LIMIT))
  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2)
}
