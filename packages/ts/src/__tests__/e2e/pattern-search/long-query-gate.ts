import { BroadcastChannel } from 'node:worker_threads'

const GATE_CHANNEL = 'narsil-hostile-long-query-gate'
const REPLY_TIMEOUT_MS = 30_000

interface GateMessage {
  workerId?: unknown
  armed?: unknown
  held?: unknown
  released?: unknown
  answer?: unknown
  moved?: unknown
  probed?: unknown
  started?: unknown
}

export interface HeldAnswer {
  status: number
  body: string
}

export interface LongQueryReport {
  movedSinceClosed: number
  heldAnswer: HeldAnswer | null
}

function heldAnswerOf(answer: unknown): HeldAnswer | null {
  if (typeof answer !== 'object' || answer === null) return null
  const { status, body } = answer as { status?: unknown; body?: unknown }
  return typeof status === 'number' && typeof body === 'string' ? { status, body } : null
}

export interface HeldMove {
  readonly held: Promise<void>
}

export interface LongQueryGate {
  readonly bootstrapModule: string
  holdNextMove(): Promise<HeldMove>
  release(): Promise<void>
  report(): Promise<LongQueryReport>
  moved(): Promise<void>
  stop(): void
}

function gateModule(): string {
  const source = `import { BroadcastChannel, MessagePort, workerData } from 'node:worker_threads'
const workerId = workerData?.workerId
const channel = new BroadcastChannel(${JSON.stringify(GATE_CHANNEL)})
const decoder = new TextDecoder()
let moved = 0
let armed = false
let holding = null
let answering = null
const portListeners = new WeakMap()
const post = MessagePort.prototype.postMessage
MessagePort.prototype.postMessage = function (message, transfer) {
  if (answering !== null && this === answering.port && message?.requestId === answering.requestId) {
    if (message.type === 'response') {
      answering.answer = { status: message.status, body: decoder.decode(message.body) }
    } else if (message.type === 'stream-start') {
      answering.status = message.status
    } else if (message.type === 'stream-chunk') {
      answering.body += decoder.decode(message.chunk, { stream: true })
    } else if (message.type === 'stream-end' && !message.failed) {
      answering.answer = { status: answering.status, body: answering.body + decoder.decode() }
    }
  }
  return post.call(this, message, transfer)
}
const on = MessagePort.prototype.on
MessagePort.prototype.on = function (type, listener) {
  if (type === 'message') {
    let listeners = portListeners.get(this)
    if (listeners === undefined) {
      listeners = []
      portListeners.set(this, listeners)
      const port = this
      const held = listeners
      this.addEventListener('message', event => {
        if (event.data?.type !== 'request' || typeof event.data.requestId !== 'number') return
        moved += 1
        channel.postMessage({ started: workerId })
        if (!armed) return
        armed = false
        event.stopImmediatePropagation()
        holding = { port, data: event.data, listeners: held }
        answering = { port, requestId: event.data.requestId, status: 0, body: '', answer: null }
        channel.postMessage({ held: workerId })
      })
    }
    listeners.push(listener)
  }
  return on.call(this, type, listener)
}
function release() {
  armed = false
  const released = holding
  holding = null
  if (released !== null) for (const listener of released.listeners) listener.call(released.port, released.data)
}
channel.onmessage = message => {
  const data = message.data
  if (data?.hold === workerId) {
    moved = 0
    armed = true
    answering = null
    channel.postMessage({ armed: workerId })
  } else if (data?.release === workerId) {
    release()
    channel.postMessage({ released: workerId })
  } else if (typeof data?.probe === 'number') {
    channel.postMessage({ probed: data.probe, workerId, moved, answer: answering?.answer ?? null })
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
    async moved() {
      await awaitReplies(data => typeof data.started === 'number', 1)
    },
    async holdNextMove() {
      const target = longQueryWorker()
      const armed = awaitReplies(data => data.armed === target, 1)
      const held = awaitReplies(data => data.held === target, 1).then(() => undefined)
      void held.catch(() => undefined)
      channel.postMessage({ hold: target })
      await armed
      return { held }
    },
    async release() {
      const target = longQueryWorker()
      const released = awaitReplies(data => data.released === target, 1)
      channel.postMessage({ release: target })
      await released
    },
    async report() {
      const target = longQueryWorker()
      probes += 1
      const probe = probes
      const replies = awaitReplies(data => data.probed === probe && typeof data.workerId === 'number', workers.size)
      channel.postMessage({ probe })
      let movedSinceClosed = 0
      let heldAnswer: HeldAnswer | null = null
      for (const reply of await replies) {
        if (reply.workerId !== target) continue
        if (typeof reply.moved === 'number') movedSinceClosed = reply.moved
        heldAnswer = heldAnswerOf(reply.answer)
      }
      return { movedSinceClosed, heldAnswer }
    },
    stop() {
      listeners.clear()
      channel.close()
    },
  }
}
