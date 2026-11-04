import { adoptBackgroundScheduler } from './shared-turns.browser'
import { createTurnScheduler, type ScheduleHop } from './turn-scheduler'

function messageChannelHop(): ScheduleHop {
  let channel: MessageChannel | null = null
  let pending: (() => void) | null = null
  return run => {
    pending = run
    if (channel === null) {
      channel = new MessageChannel()
      channel.port1.onmessage = () => {
        const next = pending
        pending = null
        next?.()
      }
    }
    channel.port2.postMessage(null)
  }
}

let sharing = false

export function shareTurnsWithBackgroundWork(): void {
  if (sharing) return
  sharing = true
  adoptBackgroundScheduler(createTurnScheduler(messageChannelHop()))
}
