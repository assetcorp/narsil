import { createWorkletRuntime, scheduleOnRN, scheduleOnRuntime, type WorkletRuntime } from 'react-native-worklets'
import type { CorpusDocument } from '../../expo/src/corpus'
import { type EngineReceipt, holdEngine, receivePart, reportReceipt, resetReceipt } from './transfer-split-engine'

const SPLIT_PART_ITEMS = 500
const ENGINE_HOLD_MARGIN_MS = 500

type Encoding = 'objects' | 'json'

interface SentParts {
  appEncodeMs: number
  appCopyMs: number
  wallMs: number
  engine: EngineReceipt
}

export interface TransferSplit {
  documents: number
  partItems: number
  appEncodeMs: number
  appCopyMs: number
  engineCopyMs: number
  engineParseMs: number
  engineIdleMs: number
  wallMs: number
}

function sendParts(
  runtime: WorkletRuntime,
  parts: readonly CorpusDocument[][],
  encoding: Encoding,
  holdMs: number,
): Promise<SentParts> {
  return new Promise((resolve, reject) => {
    function failed(text: string): void {
      reject(new Error(`The ${encoding} transfer probe threw on its runtime: ${text}`))
    }
    scheduleOnRuntime(
      runtime,
      (fail: (text: string) => void) => {
        'worklet'
        try {
          resetReceipt()
        } catch (error) {
          scheduleOnRN(fail, `resetting the receipt: ${String(error)}`)
        }
      },
      failed,
    )
    if (holdMs > 0) {
      scheduleOnRuntime(
        runtime,
        (ms: number, fail: (text: string) => void) => {
          'worklet'
          try {
            holdEngine(ms)
          } catch (error) {
            scheduleOnRN(fail, `holding the engine: ${String(error)}`)
          }
        },
        holdMs,
        failed,
      )
    }
    const startedAt = performance.now()
    let appEncodeMs = 0
    let appCopyMs = 0
    for (const part of parts) {
      const encodeStartedAt = performance.now()
      const payload: unknown = encoding === 'json' ? JSON.stringify(part) : part
      const copyStartedAt = performance.now()
      scheduleOnRuntime(
        runtime,
        (value: unknown, isText: boolean, fail: (text: string) => void) => {
          'worklet'
          try {
            receivePart(value, isText)
          } catch (error) {
            scheduleOnRN(fail, `receiving a part: ${String(error)}`)
          }
        },
        payload,
        encoding === 'json',
        failed,
      )
      appEncodeMs += copyStartedAt - encodeStartedAt
      appCopyMs += performance.now() - copyStartedAt
    }
    function received(engine: EngineReceipt): void {
      resolve({ appEncodeMs, appCopyMs, wallMs: performance.now() - startedAt, engine })
    }
    scheduleOnRuntime(
      runtime,
      (done: (engine: EngineReceipt) => void, fail: (text: string) => void) => {
        'worklet'
        try {
          reportReceipt(done)
        } catch (error) {
          scheduleOnRN(fail, `reporting the receipt: ${String(error)}`)
        }
      },
      received,
      failed,
    )
  })
}

async function splitOf(
  runtime: WorkletRuntime,
  documents: readonly CorpusDocument[],
  encoding: Encoding,
): Promise<TransferSplit> {
  const parts: CorpusDocument[][] = []
  for (let start = 0; start < documents.length; start += SPLIT_PART_ITEMS) {
    parts.push(documents.slice(start, start + SPLIT_PART_ITEMS))
  }
  const free = await sendParts(runtime, parts, encoding, 0)
  const held = await sendParts(runtime, parts, encoding, free.appEncodeMs + free.appCopyMs + ENGINE_HOLD_MARGIN_MS)
  const engineFailure = free.engine.error ?? held.engine.error
  if (engineFailure !== null) throw new Error(`On the ${encoding} transfer, ${engineFailure}`)
  const engineCopyMs = held.engine.lastEndedAt - held.engine.heldUntil - held.engine.workMs
  if (free.engine.items !== documents.length || held.engine.items !== documents.length) {
    throw new Error(
      `The engine received ${free.engine.items} and ${held.engine.items} of ${documents.length} documents`,
    )
  }
  return {
    documents: documents.length,
    partItems: SPLIT_PART_ITEMS,
    appEncodeMs: free.appEncodeMs,
    appCopyMs: free.appCopyMs,
    engineCopyMs,
    engineParseMs: free.engine.workMs,
    engineIdleMs: free.wallMs - engineCopyMs - free.engine.workMs,
    wallMs: free.wallMs,
  }
}

export async function measureTransferSplit(
  documents: readonly CorpusDocument[],
): Promise<Record<Encoding, TransferSplit>> {
  const runtime = createWorkletRuntime({ name: 'narsil-transfer-split' })
  return {
    objects: await splitOf(runtime, documents, 'objects'),
    json: await splitOf(runtime, documents, 'json'),
  }
}
