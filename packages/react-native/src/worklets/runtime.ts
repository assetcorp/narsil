import type { BoxedHybridObject } from 'react-native-nitro-modules'
import { createWorkletRuntime, scheduleOnRuntime, type WorkletRuntime } from 'react-native-worklets'
import { ENGINE_RUNTIME_NAME } from '../constants'
import {
  adoptAppThreadPriorityOn,
  installWorkletDispatcherOn,
  type NativeObjects,
  threadPriorityOf,
} from '../engine/host'
import { installEngineHost } from '../engine/install'
import type { EngineMethod } from '../methods'
import type { NarsilCore } from '../specs/core.nitro'
import type { NarsilFiles } from '../specs/files.nitro'
import type { NarsilHost } from '../specs/host.nitro'
import type { CallOutcome } from '../transferred'
import {
  callOnEngine,
  dropCallParts,
  listenOnEngine,
  openOnEngine,
  recordEngineStartFailure,
  stageCallPart,
  stageCallPartText,
} from './instances'
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
  const appThreadPriority = threadPriorityOf(host.unbox())
  const runtime = createWorkletRuntime({
    name: ENGINE_RUNTIME_NAME,
    initializer: () => {
      'worklet'
      try {
        const nativeHost = host.unbox()
        const nativeThreads = installWorkletDispatcherOn(nativeHost)
        installEngineHost({ host: nativeHost, files: files.unbox(), core: core.unbox() }, nativeThreads)
      } catch (error) {
        recordEngineStartFailure(error)
      }
    },
  })
  if (appThreadPriority !== null) {
    scheduleOnRuntime(
      runtime,
      (priority: number) => {
        'worklet'
        try {
          adoptAppThreadPriorityOn(host.unbox(), priority)
        } catch {}
      },
      appThreadPriority,
    )
  }
  engineRuntime = runtime
  return runtime
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
  args: readonly unknown[],
  partedArgs: readonly number[],
): void {
  scheduleOnRuntime(
    runtime,
    (
      id: number,
      deliver: Settle,
      instance: number,
      name: EngineMethod,
      values: readonly unknown[],
      parted: readonly number[],
    ) => {
      'worklet'
      callOnEngine(id, deliver, instance, name, values, parted)
    },
    callId,
    settle,
    instanceId,
    method,
    args,
    partedArgs,
  )
}

export function sendCallPart(
  runtime: WorkletRuntime,
  callId: number,
  argIndex: number,
  items: readonly unknown[],
): void {
  scheduleOnRuntime(
    runtime,
    (id: number, index: number, part: readonly unknown[]) => {
      'worklet'
      stageCallPart(id, index, part)
    },
    callId,
    argIndex,
    items,
  )
}

export function sendCallPartText(runtime: WorkletRuntime, callId: number, argIndex: number, text: string): void {
  scheduleOnRuntime(
    runtime,
    (id: number, index: number, part: string) => {
      'worklet'
      stageCallPartText(id, index, part)
    },
    callId,
    argIndex,
    text,
  )
}

export function sendDropCallParts(runtime: WorkletRuntime, callId: number): void {
  scheduleOnRuntime(
    runtime,
    (id: number) => {
      'worklet'
      dropCallParts(id)
    },
    callId,
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
