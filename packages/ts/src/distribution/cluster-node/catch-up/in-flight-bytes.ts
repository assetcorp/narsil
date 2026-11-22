import { MAX_CATCH_UP_IN_FLIGHT_BYTES } from '../constants'
import type { CatchUpState } from './state'

export function releaseInFlightBytes(state: CatchUpState, bytes: number): void {
  state.inFlightBytes -= bytes
  for (const wake of state.inFlightByteWaiters.splice(0)) wake()
}

export async function reserveInFlightBytesWhenFree(state: CatchUpState, bytes: number): Promise<number> {
  const reserved = Math.min(bytes, MAX_CATCH_UP_IN_FLIGHT_BYTES)
  while (state.inFlightBytes + reserved > MAX_CATCH_UP_IN_FLIGHT_BYTES) {
    await new Promise<void>(resolve => {
      state.inFlightByteWaiters.push(resolve)
    })
  }
  state.inFlightBytes += reserved
  return reserved
}
