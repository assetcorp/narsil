import type { NarsilHost } from '../../specs/host.nitro'

const MILLISECONDS_PER_SECOND = 1_000

interface ProcessLike {
  pid?: unknown
  uptime?: unknown
}

export function installProcess(host: NarsilHost): void {
  const scope = globalThis as { process?: ProcessLike }
  const existing = scope.process
  const processInfo: ProcessLike = existing ?? {}
  if (typeof processInfo.pid !== 'number') {
    Object.defineProperty(processInfo, 'pid', { value: host.processId(), writable: true, configurable: true })
  }
  if (typeof processInfo.uptime !== 'function') {
    const startedAtMs = host.processStartedAtMs()
    const uptime = () => Math.max(0, Date.now() - startedAtMs) / MILLISECONDS_PER_SECOND
    Object.defineProperty(processInfo, 'uptime', { value: uptime, writable: true, configurable: true })
  }
  if (existing === undefined) {
    Object.defineProperty(globalThis, 'process', {
      value: processInfo,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }
}
