import type { NodeLifecycleConfig } from './types'

export interface RegistrationHeartbeatState {
  timer: ReturnType<typeof setInterval> | null
}

export function createRegistrationHeartbeatState(): RegistrationHeartbeatState {
  return { timer: null }
}

export function startRegistrationHeartbeat(state: RegistrationHeartbeatState, config: NodeLifecycleConfig): void {
  stopRegistrationHeartbeat(state)

  state.timer = setInterval(() => {
    config.coordinator.registerNode(config.registration).catch((error: unknown) => {
      if (config.onError !== undefined) {
        config.onError(error)
      }
    })
  }, config.nodeHeartbeatIntervalMs)

  state.timer.unref?.()
}

export function stopRegistrationHeartbeat(state: RegistrationHeartbeatState): void {
  if (state.timer !== null) {
    clearInterval(state.timer)
    state.timer = null
  }
}
