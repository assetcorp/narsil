import process from 'node:process'
import { type DemoServerChildMessage, startDemoNarsilServer } from './demo-server.ts'

/* Entry for the demo Narsil server's own process. Checkpoint recovery is
 * CPU-bound, so running it here keeps the app dev server responsive. */

function send(message: DemoServerChildMessage): void {
  if (process.connected) process.send?.(message)
}

let close: (() => Promise<void>) | null = null

function shutdown(): void {
  const closing = close ? close() : Promise.resolve()
  closing
    .catch(() => {})
    .finally(() => {
      process.exit(0)
    })
}

/* Registered before recovery starts: the IPC channel closes when the parent
 * dev process dies, and an exit mid-recovery is safe because recovery only
 * reads from disk. */
process.on('disconnect', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

try {
  const server = await startDemoNarsilServer()
  close = server.close
  send({ type: 'ready', url: server.url })
} catch (err) {
  send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
}
