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

interface EngineStart {
  failed: boolean
  error: unknown
}

const FORWARDED = new Set<string>(FORWARDED_METHODS)
const STREAMED = new Set<string>(STREAMED_METHODS)
const UNDELIVERABLE_OUTCOME: CallOutcome = {
  ok: false,
  error: {
    transferredError: true,
    name: 'Error',
    message: "The engine's runtime could not send this call's outcome back to the app",
    code: undefined,
    details: undefined,
  },
}
const instances = new Map<number, OpenInstance>()
const stagedParts = new Map<number, Map<number, unknown[]>>()
const failedCalls = new Map<number, unknown>()
const engineStart: EngineStart = { failed: false, error: undefined }
let nextInstanceId = 1

function instanceOf(instanceId: number): OpenInstance {
  const instance = instances.get(instanceId)
  if (instance === undefined) {
    throw new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'This Narsil instance has been shut down')
  }
  return instance
}

function failureOf(error: unknown): CallOutcome {
  return { ok: false, error: transferredError(error) }
}

function deliver(settle: Settle, callId: number, outcome: () => CallOutcome): void {
  try {
    scheduleOnRN(settle, callId, outcome())
    return
  } catch (error) {
    try {
      scheduleOnRN(settle, callId, failureOf(error))
      return
    } catch {}
  }
  try {
    scheduleOnRN(settle, callId, UNDELIVERABLE_OUTCOME)
  } catch {}
}

function report(settle: Settle, callId: number, work: () => Promise<unknown>): void {
  let pending: Promise<unknown>
  try {
    pending = work()
  } catch (error) {
    deliver(settle, callId, () => failureOf(error))
    return
  }
  pending.then(
    value => deliver(settle, callId, () => ({ ok: true, value: transferable(value) })),
    error => deliver(settle, callId, () => failureOf(error)),
  )
}

export function recordEngineStartFailure(error: unknown): void {
  engineStart.failed = true
  engineStart.error = error
}

async function openInstance(config: WorkletNarsilConfig, setup: EngineSetup | undefined): Promise<number> {
  if (engineStart.failed) throw engineStart.error
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

function failCall(callId: number, error: unknown): void {
  stagedParts.delete(callId)
  failedCalls.set(callId, error)
}

function stageItems(callId: number, argIndex: number, items: unknown): void {
  if (!Array.isArray(items)) throw new TypeError('A part of a call reached the engine without its items')
  let parts = stagedParts.get(callId)
  if (parts === undefined) {
    parts = new Map()
    stagedParts.set(callId, parts)
  }
  let staged = parts.get(argIndex)
  if (staged === undefined) {
    staged = []
    parts.set(argIndex, staged)
  }
  for (const item of items) staged.push(item)
}

export function stageCallPart(callId: number, argIndex: number, items: readonly unknown[]): void {
  if (failedCalls.has(callId)) return
  try {
    stageItems(callId, argIndex, items)
  } catch (error) {
    failCall(callId, error)
  }
}

export function stageCallPartText(callId: number, argIndex: number, text: string): void {
  if (failedCalls.has(callId)) return
  try {
    stageItems(callId, argIndex, JSON.parse(text))
  } catch (error) {
    failCall(callId, error)
  }
}

export function dropCallParts(callId: number): void {
  stagedParts.delete(callId)
  failedCalls.delete(callId)
}

function withStagedParts(callId: number, args: readonly unknown[], partedArgs: readonly number[]): unknown[] {
  const parts = stagedParts.get(callId)
  const failure = failedCalls.get(callId)
  stagedParts.delete(callId)
  if (failedCalls.delete(callId)) throw failure
  const values = [...args]
  for (const argIndex of partedArgs) values[argIndex] = parts?.get(argIndex) ?? []
  return values
}

export function callOnEngine(
  callId: number,
  settle: Settle,
  instanceId: number,
  method: EngineMethod,
  args: readonly unknown[],
  partedArgs: readonly number[],
): void {
  report(settle, callId, () =>
    dispatch(instanceId, method, partedArgs.length === 0 ? args : withStagedParts(callId, args, partedArgs)),
  )
}

function forwardEvent(forward: DeliverEvent, instanceId: number, event: EventName, payload: unknown): void {
  try {
    scheduleOnRN(forward, instanceId, event, transferable(payload))
  } catch {}
}

function changeListener(instanceId: number, event: EventName, forward: DeliverEvent, listening: boolean): void {
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
  const listener = (payload: unknown) => forwardEvent(forward, instanceId, event, payload)
  instance.listeners.set(event, listener)
  try {
    instance.narsil.on(event, listener)
  } catch (error) {
    instance.listeners.delete(event)
    throw error
  }
}

export function listenOnEngine(instanceId: number, event: EventName, forward: DeliverEvent, listening: boolean): void {
  try {
    changeListener(instanceId, event, forward, listening)
  } catch {}
}
