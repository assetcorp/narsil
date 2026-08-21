import type { NodeLifecycleConfig } from './types'

export interface RegistrationHeartbeatState {
  timer: ReturnType<typeof setInterval> | null
  inFlight: Promise<void>
}

/**
 * Builds the state a node's registration heartbeat keeps, which starts with no timer and no renewal in flight.
 *
 * @returns The fresh state, ready for {@link startRegistrationHeartbeat}.
 */
export function createRegistrationHeartbeatState(): RegistrationHeartbeatState {
  return { timer: null, inFlight: Promise.resolve() }
}

function clearHeartbeatTimer(state: RegistrationHeartbeatState): void {
  if (state.timer !== null) {
    clearInterval(state.timer)
    state.timer = null
  }
}

/**
 * Starts renewing a node's registration, so that the coordinator keeps reporting the node as a member.
 *
 * A registration expires on the coordinator once its lease runs out, and this renewal is what holds the lease open
 * for as long as the node stays in the cluster. Each renewal waits for the one before it, so two of them never
 * overlap, and a renewal that fails reaches `config.onError` rather than the caller.
 *
 * @param state - The heartbeat state, whose previous timer this call replaces.
 * @param config - The lifecycle configuration, which names the coordinator, the registration, and the interval.
 */
export function startRegistrationHeartbeat(state: RegistrationHeartbeatState, config: NodeLifecycleConfig): void {
  clearHeartbeatTimer(state)

  state.timer = setInterval(() => {
    state.inFlight = state.inFlight
      .then(() => config.coordinator.registerNode(config.registration))
      .catch((error: unknown) => {
        if (config.onError !== undefined) {
          config.onError(error)
        }
      })
  }, config.nodeHeartbeatIntervalMs)

  state.timer.unref?.()
}

/**
 * Stops renewing a node's registration and waits for the renewal already in flight.
 *
 * A caller that deregisters the node must await this first, because a renewal that lands after the deregistration
 * would write the registration back and leave the coordinator reporting a node that has left.
 *
 * @param state - The heartbeat state to stop.
 * @returns A promise that settles once no renewal is in flight.
 */
export async function stopRegistrationHeartbeat(state: RegistrationHeartbeatState): Promise<void> {
  clearHeartbeatTimer(state)
  await state.inFlight
}
