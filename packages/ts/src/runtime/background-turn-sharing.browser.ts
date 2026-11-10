import { adoptBackgroundScheduler } from '../vector/vector-host/index.browser'
import { createTurnScheduler, type ScheduleHop } from './turn-scheduler'

interface ReleasablePort extends MessagePort {
  ref?(): void
  unref?(): void
}

interface ChannelHop {
  readonly schedule: ScheduleHop
  closeWhileIdle(): void
}

function messageChannelHop(): ChannelHop {
  let channel: MessageChannel | null = null
  let receiver: ReleasablePort | null = null
  let pending: (() => void) | null = null
  function openChannel(): ReleasablePort {
    const opened = new MessageChannel()
    const port: ReleasablePort = opened.port1
    port.onmessage = () => {
      const next = pending
      pending = null
      next?.()
      if (pending === null) port.unref?.()
    }
    channel = opened
    receiver = port
    return port
  }
  return {
    schedule: run => {
      pending = run
      const port = receiver ?? openChannel()
      port.ref?.()
      channel?.port2.postMessage(null)
    },
    closeWhileIdle: () => {
      if (pending !== null || channel === null) return
      channel.port1.close()
      channel.port2.close()
      channel = null
      receiver = null
    },
  }
}

let sharedHop: ChannelHop | null = null

export function shareTurnsWithBackgroundWork(): void {
  if (sharedHop !== null) return
  sharedHop = messageChannelHop()
  adoptBackgroundScheduler(createTurnScheduler(sharedHop.schedule))
}

export function closeIdleTurnHop(): void {
  sharedHop?.closeWhileIdle()
}
