import type { BoxedHybridObject } from 'react-native-nitro-modules'
import { createWorkletRuntime, scheduleOnRuntime, type WorkletRuntime } from 'react-native-worklets'
import { ENGINE_RUNTIME_NAME } from '../constants'
import type { NativeObjects } from '../engine/host'
import { installEngineHost } from '../engine/install'
import type { EngineMethod } from '../methods'
import type { NarsilCore } from '../specs/core.nitro'
import type { NarsilFiles } from '../specs/files.nitro'
import type { NarsilHost } from '../specs/host.nitro'
import type { CallOutcome } from '../transferred'
import { callOnEngine, listenOnEngine, openOnEngine } from './instances'
import type { EngineSetup, WorkletNarsilConfig } from './types'

type Settle = (callId: number, outcome: CallOutcome) => void
type DeliverEvent = (instanceId: number, event: string, payload: unknown) => void

export interface BoxedNativeObjects {
  host: BoxedHybridObject<NarsilHost>
  files: BoxedHybridObject<NarsilFiles>
  core: BoxedHybridObject<NarsilCore>
}

let engineRuntime: WorkletRuntime | null = null

export async function boxNativeObjects(natives: NativeObjects): Promise<BoxedNativeObjects> {
  const { NitroModules } = await import('react-native-nitro-modules')
  return {
    host: NitroModules.box(natives.host),
    files: NitroModules.box(natives.files),
    core: NitroModules.box(natives.core),
  }
}

export function startEngineRuntime({ host, files, core }: BoxedNativeObjects): WorkletRuntime {
  if (engineRuntime !== null) return engineRuntime
  engineRuntime = createWorkletRuntime({
    name: ENGINE_RUNTIME_NAME,
    initializer: () => {
      'worklet'
      installEngineHost({ host: host.unbox(), files: files.unbox(), core: core.unbox() }, false)
    },
  })
  return engineRuntime
}

export function sendOpen(
  runtime: WorkletRuntime,
  callId: number,
  settle: Settle,
  config: WorkletNarsilConfig,
  setup: EngineSetup | undefined,
): void {
  scheduleOnRuntime(
    runtime,
    (id: number, deliver: Settle, settings: WorkletNarsilConfig, prepare: EngineSetup | undefined) => {
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
