import { BroadcastChannel } from 'node:worker_threads'

const GATE_CHANNEL = 'narsil-hostile-long-query-gate'
const REPLY_TIMEOUT_MS = 30_000
const HELD_AT_MOST_MS = 20_000

interface GateMessage {
  workerId?: unknown
  closed?: unknown
  busyMs?: unknown
  moved?: unknown
  probed?: unknown
}

export interface LongQueryReport {
  longQuery: number
  others: number[]
  movedSinceClosed: number
}

export interface LongQueryGate {
  readonly bootstrapModule: string
  close(): Promise<void>
  open(): void
  report(): Promise<LongQueryReport>
  stop(): void
}

function gateModule(): string {
  const source = `import { BroadcastChannel, MessagePort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
const workerId = workerData?.workerId
const channel = new BroadcastChannel(${JSON.stringify(GATE_CHANNEL)})
let since = performance.eventLoopUtilization()
let moved = 0
const counted = new WeakSet()
const on = MessagePort.prototype.on
MessagePort.prototype.on = function (type, listener) {
  if (type === 'message' && !counted.has(this)) {
    counted.add(this)
    this.addEventListener('message', event => {
      if (event.data?.type === 'request' && typeof event.data.requestId === 'number') moved += 1
    })
  }
  return on.call(this, type, listener)
}
channel.onmessage = message => {
  const data = message.data
  if (data?.close === workerId) {
    moved = 0
    channel.postMessage({ closed: workerId })
    Atomics.wait(new Int32Array(data.gate), 0, 0, ${HELD_AT_MOST_MS})
    since = performance.eventLoopUtilization()
  } else if (data?.mark === true && data.except !== workerId) {
    since = performance.eventLoopUtilization()
  } else if (typeof data?.probe === 'number') {
    channel.postMessage({ probed: data.probe, workerId, moved, busyMs: performance.eventLoopUtilization(since).active })
  }
}
channel.unref()
channel.postMessage({ workerId })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

export function createLongQueryGate(): LongQueryGate {
  const channel = new BroadcastChannel(GATE_CHANNEL)
  const workers = new Set<number>()
  const listeners = new Set<(data: GateMessage) => void>()
  let gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  let probes = 0

  channel.onmessage = (message: unknown) => {
    const data = (message as { data?: GateMessage }).data
    if (data === undefined) return
    if (typeof data.workerId === 'number') workers.add(data.workerId)
    for (const listener of listeners) listener(data)
  }

  function longQueryWorker(): number {
    if (workers.size === 0) throw new Error('No worker announced itself through the gate module')
    return Math.max(...workers)
  }

  function awaitReplies(accept: (data: GateMessage) => boolean, count: number): Promise<GateMessage[]> {
    return new Promise((resolve, reject) => {
      const replies: GateMessage[] = []
      const timer = setTimeout(() => {
        listeners.delete(listener)
        reject(new Error(`The gate module answered ${replies.length} of ${count} messages`))
      }, REPLY_TIMEOUT_MS)
      const listener = (data: GateMessage): void => {
        if (!accept(data)) return
        replies.push(data)
        if (replies.length < count) return
        clearTimeout(timer)
        listeners.delete(listener)
        resolve(replies)
      }
      listeners.add(listener)
    })
  }

  return {
    bootstrapModule: gateModule(),
    async close() {
      const target = longQueryWorker()
      gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
      const closed = awaitReplies(data => data.closed === target, 1)
      channel.postMessage({ close: target, gate: gate.buffer })
      await closed
    },
    open() {
      channel.postMessage({ mark: true, except: longQueryWorker() })
      Atomics.store(gate, 0, 1)
      Atomics.notify(gate, 0)
    },
    async report() {
      const target = longQueryWorker()
      probes += 1
      const probe = probes
      const replies = awaitReplies(data => data.probed === probe && typeof data.workerId === 'number', workers.size)
      channel.postMessage({ probe })
      const busy = new Map<number, number>()
      let movedSinceClosed = 0
      for (const reply of await replies) {
        if (typeof reply.workerId !== 'number' || typeof reply.busyMs !== 'number') continue
        busy.set(reply.workerId, reply.busyMs)
        if (reply.workerId === target && typeof reply.moved === 'number') movedSinceClosed = reply.moved
      }
      return {
        longQuery: busy.get(target) ?? 0,
        others: [...busy].filter(([workerId]) => workerId !== target).map(([, busyMs]) => busyMs),
        movedSinceClosed,
      }
    },
    stop() {
      listeners.clear()
      channel.close()
    },
  }
}
