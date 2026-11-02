import type { NarsilEventMap } from '@delali/narsil'
import { isWorkletFunction, type WorkletRuntime } from 'react-native-worklets'
import { rebuiltError, rebuiltValue } from '../errors'
import { type EngineMethod, FORWARDED_METHODS, STREAMED_METHODS } from '../methods'
import { loadNativeObjects } from '../native-objects'
import type { CallOutcome } from '../transferred'
import type { PhoneNarsil } from '../types'
import { boxNativeObjects, sendCall, sendListen, sendOpen, startEngineRuntime } from './runtime'
import type { EngineSetup, WorkletNarsilConfig } from './types'

type EventName = keyof NarsilEventMap
type AnyHandler = (payload: never) => void

interface PendingCall {
  resolve(value: unknown): void
  reject(error: unknown): void
}

const pendingCalls = new Map<number, PendingCall>()
const handlersByInstance = new Map<number, Map<EventName, Set<AnyHandler>>>()
let nextCallId = 1

function settleCall(callId: number, outcome: CallOutcome): void {
  const pending = pendingCalls.get(callId)
  if (pending === undefined) return
  pendingCalls.delete(callId)
  if (outcome.ok) pending.resolve(outcome.value)
  else pending.reject(rebuiltError(outcome.error))
}

function deliverEvent(instanceId: number, event: string, payload: unknown): void {
  const handlers = handlersByInstance.get(instanceId)?.get(event as EventName)
  if (handlers === undefined) return
  const rebuilt = rebuiltValue(payload) as never
  for (const handler of [...handlers]) {
    try {
      handler(rebuilt)
    } catch (error) {
      setTimeout(() => {
        throw error
      }, 0)
    }
  }
}

function request(send: (callId: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callId = nextCallId++
    pendingCalls.set(callId, { resolve, reject })
    try {
      send(callId)
    } catch (error) {
      pendingCalls.delete(callId)
      reject(error)
    }
  })
}

function phoneNarsil(runtime: WorkletRuntime, instanceId: number): PhoneNarsil {
  const handlers = new Map<EventName, Set<AnyHandler>>()
  handlersByInstance.set(instanceId, handlers)

  function call(method: EngineMethod, args: unknown[]): Promise<unknown> {
    return request(callId => sendCall(runtime, callId, settleCall, instanceId, method, args))
  }

  const client: Record<string, unknown> = {}
  for (const method of [...FORWARDED_METHODS, ...STREAMED_METHODS]) {
    client[method] = (...args: unknown[]) => call(method, args)
  }

  client.on = (event: EventName, handler: AnyHandler) => {
    let registered = handlers.get(event)
    if (registered === undefined) {
      registered = new Set()
      handlers.set(event, registered)
    }
    const first = registered.size === 0
    registered.add(handler)
    if (first) sendListen(runtime, instanceId, event, deliverEvent, true)
  }

  client.off = (event: EventName, handler: AnyHandler) => {
    const registered = handlers.get(event)
    if (registered === undefined || !registered.delete(handler)) return
    if (registered.size > 0) return
    handlers.delete(event)
    sendListen(runtime, instanceId, event, deliverEvent, false)
  }

  client.shutdown = async () => {
    try {
      await call('shutdown', [])
    } finally {
      handlers.clear()
      handlersByInstance.delete(instanceId)
    }
  }

  return client as unknown as PhoneNarsil
}

/**
 * Starts a Narsil engine on its own Worklets runtime and resolves with a
 * client whose methods send each request to that runtime, so the engine's
 * JavaScript work leaves the app's JS thread free. Every engine that this
 * function starts shares one runtime, and each engine keeps its own indexes.
 * The app needs `react-native-worklets` with Bundle Mode turned on.
 *
 * @param config - The engine settings that cross to the engine's runtime as
 * data. `durability` defaults to a write-ahead log in the `narsil` directory
 * of the app's private storage.
 * @param setup - A worklet that returns the settings that hold functions,
 * such as embedding adapters, plugins, or an id generator.
 * @returns The client, once the engine has started on its runtime.
 * @throws A `NarsilError` with `NATIVE_DEPENDENCY_MISSING` when the app's
 * build lacks the native module, as in Expo Go.
 *
 * @public
 */
export async function createNarsil(config: WorkletNarsilConfig = {}, setup?: EngineSetup): Promise<PhoneNarsil> {
  if (setup !== undefined && !isWorkletFunction(setup)) {
    throw new TypeError("The setup function must be a worklet, so start its body with the 'worklet' directive")
  }
  const natives = await loadNativeObjects()
  const runtime = startEngineRuntime(await boxNativeObjects(natives))
  const instanceId = await request(callId => sendOpen(runtime, callId, settleCall, config, setup))
  return phoneNarsil(runtime, instanceId as number)
}
