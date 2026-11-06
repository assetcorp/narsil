import { type FileOutcome, type MergeResult, Merger, type MergeSettings } from './merge'

export type MergeRequest =
  | { type: 'start'; settings: MergeSettings }
  | { type: 'file'; id: number; day: string; bytes: Uint8Array }
  | { type: 'finish' }

export type MergeReply =
  | { type: 'file'; id: number; outcome: FileOutcome }
  | { type: 'result'; result: MergeResult }
  | { type: 'error'; message: string }

async function listen(): Promise<void> {
  let port: import('node:worker_threads').MessagePort | null = null
  try {
    port = (await import('node:worker_threads')).parentPort ?? null
  } catch {
    port = null
  }
  if (port === null) return
  const replies = port
  let merger: Merger | null = null
  let queue: Promise<void> = Promise.resolve()
  replies.on('message', (request: MergeRequest) => {
    queue = queue.then(async () => {
      try {
        if (request.type === 'start') merger = new Merger(request.settings)
        else if (merger === null) throw new Error('The merge received work before it started')
        else if (request.type === 'file') {
          const outcome = await merger.addFile(request.bytes, request.day)
          replies.postMessage({ type: 'file', id: request.id, outcome } satisfies MergeReply)
        } else replies.postMessage({ type: 'result', result: merger.result() } satisfies MergeReply)
      } catch (error) {
        replies.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        } satisfies MergeReply)
      }
    })
  })
}

void listen()
