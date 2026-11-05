import type { Etcd3 as Etcd3Client, IDuplexStream, IKeyValue, IWatchRequest, IWatchResponse } from 'etcd3'
import { ErrorCodes, NarsilError } from '../../../errors'
import { MAX_WATCHERS } from '../constants'
import { ETCD_WATCH_ATTACH_TIMEOUT_MS } from './constants'

type RawWatchStream = IDuplexStream<IWatchRequest, IWatchResponse>

export interface WatchStreamListener {
  put(kv: IKeyValue): void
  delete(kv: IKeyValue): void
  handlerFailed(error: unknown): void
  lost(): void
}

export interface WatchStream {
  close(): Promise<void>
}

export interface WatchStreams {
  open(client: Etcd3Client, prefix: string, startRevision: string, listener: WatchStreamListener): Promise<WatchStream>
  track<T>(operation: Promise<T>): Promise<T>
  isClosed(): boolean
  closeAll(): Promise<void>
}

interface OpenStreamRegistry {
  remember(watch: WatchStream): void
  forget(watch: WatchStream): void
  isClosed(): boolean
}

export class WatchAttachError extends NarsilError {}

function shutDownError(): NarsilError {
  return new NarsilError(ErrorCodes.CONFIG_INVALID, 'Coordinator has been shut down')
}

function attachFailure(message: string): WatchAttachError {
  return new WatchAttachError(ErrorCodes.COORDINATOR_UNAVAILABLE, message)
}

function prefixRangeEnd(prefix: Buffer): Buffer {
  for (let position = prefix.length - 1; position >= 0; position--) {
    const byte = prefix[position]
    if (byte !== undefined && byte < 0xff) {
      const end = Buffer.from(prefix.subarray(0, position + 1))
      end[position] = byte + 1
      return end
    }
  }
  return Buffer.from([0])
}

async function openOne(
  client: Etcd3Client,
  prefix: string,
  startRevision: string,
  listener: WatchStreamListener,
  registry: OpenStreamRegistry,
): Promise<WatchStream> {
  const stream: RawWatchStream = await client.watchClient.watch()
  let attached = false
  let closing = false
  let finished = false
  let settleAttach: (failure: WatchAttachError | null) => void = () => {}
  let markFinished: () => void = () => {}
  const done = new Promise<void>(resolve => {
    markFinished = resolve
  })
  const attachedOrFailed = new Promise<WatchAttachError | null>(resolve => {
    settleAttach = resolve
  })

  const watch: WatchStream = {
    close() {
      if (!closing) {
        closing = true
        try {
          stream.end()
          stream.cancel()
        } catch (_) {}
      }
      return done
    },
  }

  function finish(): void {
    if (finished) return
    finished = true
    registry.forget(watch)
    markFinished()
    if (!attached) settleAttach(attachFailure('the etcd watch stream ended before etcd attached the watch'))
    else if (!closing) listener.lost()
  }

  function receive(response: IWatchResponse): void {
    if (closing || finished) return
    if (!attached) {
      if (!response.created) return
      if (response.canceled) {
        settleAttach(attachFailure(`etcd refused the watch: ${response.cancel_reason || 'no reason given'}`))
        return
      }
      attached = true
      settleAttach(null)
      return
    }
    for (const event of response.events ?? []) {
      try {
        if (event.type === 'Put') listener.put(event.kv)
        else if (event.type === 'Delete') listener.delete(event.kv)
      } catch (handlerError) {
        void watch.close()
        listener.handlerFailed(handlerError)
        listener.lost()
        return
      }
    }
    if (response.canceled) {
      void watch.close()
      listener.lost()
    }
  }

  stream.on('data', (response: IWatchResponse) => {
    try {
      receive(response)
    } catch (_) {}
  })
  stream.on('error', () => {})
  stream.on('status', () => {
    try {
      finish()
    } catch (_) {}
  })
  registry.remember(watch)

  if (registry.isClosed()) {
    await watch.close()
    throw shutDownError()
  }
  const timer = setTimeout(
    () => settleAttach(attachFailure(`etcd did not attach the watch within ${ETCD_WATCH_ATTACH_TIMEOUT_MS} ms`)),
    ETCD_WATCH_ATTACH_TIMEOUT_MS,
  )
  timer.unref?.()
  const key = Buffer.from(prefix)
  try {
    stream.write({ create_request: { key, range_end: prefixRangeEnd(key), start_revision: startRevision } })
  } catch (_) {
    settleAttach(attachFailure('the etcd watch stream refused the watch request'))
  }
  const failure = await attachedOrFailed
  clearTimeout(timer)
  if (failure !== null) {
    await watch.close()
    throw registry.isClosed() ? shutDownError() : failure
  }
  return watch
}

export function createWatchStreams(): WatchStreams {
  const open = new Set<WatchStream>()
  const pending = new Set<Promise<void>>()
  let opening = 0
  let closed = false

  function track<T>(operation: Promise<T>): Promise<T> {
    const followed = operation.then(
      () => {},
      () => {},
    )
    pending.add(followed)
    void followed.then(() => pending.delete(followed))
    return operation
  }

  async function openTracked(
    client: Etcd3Client,
    prefix: string,
    startRevision: string,
    listener: WatchStreamListener,
  ): Promise<WatchStream> {
    if (closed) throw shutDownError()
    if (open.size + opening >= MAX_WATCHERS) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Maximum watcher limit (${MAX_WATCHERS}) reached`, {
        currentCount: open.size + opening,
      })
    }
    opening += 1
    let reserved = true
    const releaseReservation = (): void => {
      if (!reserved) return
      reserved = false
      opening -= 1
    }
    const registry: OpenStreamRegistry = {
      remember(watch) {
        releaseReservation()
        open.add(watch)
      },
      forget: watch => open.delete(watch),
      isClosed: () => closed,
    }
    try {
      return await openOne(client, prefix, startRevision, listener, registry)
    } finally {
      releaseReservation()
    }
  }

  return {
    open: (client, prefix, startRevision, listener) => track(openTracked(client, prefix, startRevision, listener)),
    track,
    isClosed: () => closed,
    async closeAll() {
      closed = true
      while (open.size > 0 || pending.size > 0) {
        await Promise.all([...[...open].map(watch => watch.close()), ...pending])
      }
    },
  }
}
