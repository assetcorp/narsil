import {
  createNarsil,
  ErrorCodes,
  type Narsil,
  type NarsilConfig,
  NarsilError,
  type NarsilEventMap,
} from '@delali/narsil'
import { scheduleOnRN } from 'react-native-worklets'
import { installedHost } from '../engine/install'
import { callStreamed, withPhoneDurability } from '../engine/streamed'
import { transferable, transferredError } from '../engine/transfer'
import { type EngineMethod, FORWARDED_METHODS, STREAMED_METHODS, type StreamedMethod } from '../methods'
import type { CallOutcome } from '../transferred'
import type { EngineSetup, WorkletNarsilConfig } from './types'

type Settle = (callId: number, outcome: CallOutcome) => void
type DeliverEvent = (instanceId: number, event: EventName, payload: unknown) => void
type EventName = keyof NarsilEventMap

interface OpenInstance {
  narsil: Narsil
  listeners: Map<EventName, (payload: unknown) => void>
}

const FORWARDED = new Set<string>(FORWARDED_METHODS)
const STREAMED = new Set<string>(STREAMED_METHODS)
const instances = new Map<number, OpenInstance>()
let nextInstanceId = 1

function instanceOf(instanceId: number): OpenInstance {
  const instance = instances.get(instanceId)
  if (instance === undefined) {
    throw new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'This Narsil instance has been shut down')
  }
  return instance
}

function report(settle: Settle, callId: number, work: () => Promise<unknown>): void {
  let pending: Promise<unknown>
  try {
    pending = work()
  } catch (error) {
    scheduleOnRN(settle, callId, { ok: false, error: transferredError(error) })
    return
  }
  pending.then(
    value => scheduleOnRN(settle, callId, { ok: true, value: transferable(value) }),
    error => scheduleOnRN(settle, callId, { ok: false, error: transferredError(error) }),
  )
}

async function openInstance(config: WorkletNarsilConfig, setup: EngineSetup | undefined): Promise<number> {
  const fromSetup = setup === undefined ? {} : await setup()
  const merged: NarsilConfig = { ...withPhoneDurability(config, fromSetup.durability !== undefined), ...fromSetup }
  const narsil = await createNarsil(merged)
  const instanceId = nextInstanceId++
  instances.set(instanceId, { narsil, listeners: new Map() })
  return instanceId
}

async function shutdown(instanceId: number): Promise<void> {
  const instance = instances.get(instanceId)
  if (instance === undefined) return
  instances.delete(instanceId)
  for (const [event, listener] of instance.listeners) instance.narsil.off(event, listener)
  instance.listeners.clear()
  await instance.narsil.shutdown()
}

function dispatch(instanceId: number, method: EngineMethod, args: readonly unknown[]): Promise<unknown> {
  if (method === 'shutdown') return shutdown(instanceId)
  const { narsil } = instanceOf(instanceId)
  if (FORWARDED.has(method)) {
    const target = narsil[method as keyof Narsil] as (...values: unknown[]) => unknown
    return Promise.resolve(target.apply(narsil, [...args]))
  }
  if (!STREAMED.has(method)) throw new TypeError(`The Narsil engine has no method called ${String(method)}`)
  return callStreamed(narsil, installedHost(), method as StreamedMethod, args)
}

export function openOnEngine(
  callId: number,
  settle: Settle,
  config: WorkletNarsilConfig,
  setup: EngineSetup | undefined,
): void {
  report(settle, callId, () => openInstance(config, setup))
}

export function callOnEngine(
  callId: number,
  settle: Settle,
  instanceId: number,
  method: EngineMethod,
  args: readonly unknown[],
): void {
  report(settle, callId, () => dispatch(instanceId, method, args))
}

export function listenOnEngine(instanceId: number, event: EventName, deliver: DeliverEvent, listening: boolean): void {
  const instance = instances.get(instanceId)
  if (instance === undefined) return
  const existing = instance.listeners.get(event)
  if (!listening) {
    if (existing === undefined) return
    instance.listeners.delete(event)
    instance.narsil.off(event, existing)
    return
  }
  if (existing !== undefined) return
  const listener = (payload: unknown) => scheduleOnRN(deliver, instanceId, event, transferable(payload))
  instance.listeners.set(event, listener)
  instance.narsil.on(event, listener)
}
