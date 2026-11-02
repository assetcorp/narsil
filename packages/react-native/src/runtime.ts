import { createWorkletRuntime, scheduleOnRuntime, type WorkletRuntime } from 'react-native-worklets'
import { ENGINE_RUNTIME_NAME } from './constants'
import { installEngineHost } from './engine/install'
import { callOnEngine, listenOnEngine, openOnEngine } from './engine/instances'
import type { EngineMethod } from './methods'
import type { BoxedNativeObjects } from './native-objects'
import type { CallOutcome } from './transferred'
import type { EngineSetup, PhoneNarsilConfig } from './types'

type Settle = (callId: number, outcome: CallOutcome) => void
type DeliverEvent = (instanceId: number, event: string, payload: unknown) => void

let engineRuntime: WorkletRuntime | null = null

export function startEngineRuntime(natives: BoxedNativeObjects): WorkletRuntime {
  if (engineRuntime !== null) return engineRuntime
  const { host, files, core } = natives
  engineRuntime = createWorkletRuntime({
    name: ENGINE_RUNTIME_NAME,
    initializer: () => {
      'worklet'
      installEngineHost({ host: host.unbox(), files: files.unbox(), core: core.unbox() })
    },
  })
  return engineRuntime
}

export function sendOpen(
  runtime: WorkletRuntime,
  callId: number,
  settle: Settle,
  config: PhoneNarsilConfig,
  setup: EngineSetup | undefined,
): void {
  scheduleOnRuntime(
    runtime,
    (id: number, deliver: Settle, settings: PhoneNarsilConfig, prepare: EngineSetup | undefined) => {
      'worklet'
      openOnEngine(id, deliver, settings, prepare)
    },
    callId,
    settle,
    config,
    setup,
  )
}

export function sendCall(
  runtime: WorkletRuntime,
  callId: number,
  settle: Settle,
  instanceId: number,
  method: EngineMethod,
  args: unknown[],
): void {
  scheduleOnRuntime(
    runtime,
    (id: number, deliver: Settle, instance: number, name: EngineMethod, values: unknown[]) => {
      'worklet'
      callOnEngine(id, deliver, instance, name, values)
    },
    callId,
    settle,
    instanceId,
    method,
    args,
  )
}

export function sendListen(
  runtime: WorkletRuntime,
  instanceId: number,
  event: string,
  deliver: DeliverEvent,
  listening: boolean,
): void {
  scheduleOnRuntime(
    runtime,
    (instance: number, name: string, forward: DeliverEvent, on: boolean) => {
      'worklet'
      listenOnEngine(instance, name as Parameters<typeof listenOnEngine>[1], forward, on)
    },
    instanceId,
    event,
    deliver,
    listening,
  )
}
