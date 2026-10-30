import { DEFAULT_TRANSPORT_CONFIG } from '../../transport/types'
import type { WriteRoutingDeps } from './types'

export function replicationTimeoutOf(deps: WriteRoutingDeps): number {
  return deps.transport.timeouts?.replicationTimeout ?? DEFAULT_TRANSPORT_CONFIG.replicationTimeout
}

export async function withinDeadline<T>(work: Promise<T>, timeoutMs: number, expired: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(expired()), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([work, timedOut])
  } finally {
    clearTimeout(timer)
  }
}
