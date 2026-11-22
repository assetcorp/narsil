import type { Writable } from 'node:stream'

export function drainedOrClosed(stream: Writable): Promise<void> {
  if (stream.closed) {
    return Promise.resolve()
  }
  return new Promise<void>(resolve => {
    const settle = (): void => {
      stream.off('drain', settle)
      stream.off('close', settle)
      resolve()
    }
    stream.on('drain', settle)
    stream.on('close', settle)
  })
}
