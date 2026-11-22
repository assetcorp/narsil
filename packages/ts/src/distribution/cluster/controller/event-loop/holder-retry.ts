import { HOLDER_RETRY_BASE_MS, HOLDER_RETRY_CEILING_MS } from '../../constants'
import type { EventLoopState } from './state'

export function scheduleHolderRetry(
  state: EventLoopState,
  isActive: () => boolean,
  askAgain: () => Promise<void>,
  delayMs = HOLDER_RETRY_BASE_MS,
): void {
  if (state.holderRetryTimer !== null) {
    clearTimeout(state.holderRetryTimer)
    state.holderRetryTimer = null
  }
  if (state.indexesAwaitingHolders.size === 0 || !isActive()) return

  state.holderRetryTimer = setTimeout(() => {
    state.holderRetryTimer = null
    if (!isActive()) return
    const scheduleNext = () => {
      if (state.holderRetryTimer === null) {
        scheduleHolderRetry(state, isActive, askAgain, Math.min(delayMs * 2, HOLDER_RETRY_CEILING_MS))
      }
    }
    askAgain().then(scheduleNext, scheduleNext)
  }, delayMs)
  state.holderRetryTimer.unref?.()
}
