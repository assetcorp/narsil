import { CHANGES_SUBPROTOCOL } from '../changes/wire'
import { ClientErrorCodes, ErrorCodes, NarsilError } from '../errors'
import { loadMessagePack, type MessagePackCode } from '../serialization/msgpack-code'
import type { ChangePosition, ChangesEvent, FollowChangesOptions } from '../types/changes'
import { laterEventOf, subscribedOf } from './change-feed-messages'

/**
 * Where a subscription to the change feed starts, which changes it receives, and how it proves the caller's access.
 *
 * @public
 */
export interface ChangeFeedOptions extends FollowChangesOptions {
  /**
   * The client offers this value as a second WebSocket subprotocol, after `narsil.changes.v1`, because a browser
   * sends no header of the caller's choosing with a WebSocket upgrade. The server's `onRequest` hook reads it from
   * the `sec-websocket-protocol` header. It must hold only the characters that an HTTP token allows.
   */
  credential?: string
}

/**
 * One connection to the change feed of an index, which returns its events one at a time.
 *
 * The server stops sending once the changes that the caller has not acknowledged pass the window in bytes, so call
 * {@link ChangeSubscription.ack} with each position once the caller has saved it.
 *
 * @public
 */
export interface ChangeSubscription extends AsyncIterable<ChangesEvent> {
  /**
   * Tells the server that the caller has saved these positions, which frees the window for further changes. Pass
   * only positions that the caller has saved, each at or below a `scannedSeqNo` that the feed returned. The
   * subscription remembers the highest position of every partition and sends all of them, because the server
   * expects each acknowledgement to cover every partition.
   *
   * @param positions - The saved positions of any partitions whose position moved.
   * @throws NarsilError with `CHANGES_INVALID_POSITIONS` for a position that is not a whole number at or above
   * zero, or for a partition that the index lacks.
   */
  ack(positions: ChangePosition[]): void
  /** Closes the connection and ends the iteration. */
  close(): void
}

const CLOSE_NORMAL = 1000
const CLOSE_CREDENTIAL_EXPIRED = 4401
const CLOSE_SETTING = 4409
const CLOSE_RESYNC = 4410
const CLOSE_POLICY = 1008

function closedError(code: number, reason: string): NarsilError {
  if (code === CLOSE_SETTING && reason.length > 0) {
    return new NarsilError(reason, `The server refused the subscription with ${reason}`, { closeCode: code })
  }
  if (code === CLOSE_RESYNC) {
    return new NarsilError(ErrorCodes.CHANGES_NOT_ENABLED, 'The index has change capture off', { closeCode: code })
  }
  if (code === CLOSE_POLICY) {
    return new NarsilError(ErrorCodes.CONFIG_INVALID, `The server refused the subscription: ${reason}`, {
      closeCode: code,
    })
  }
  const why = code === CLOSE_CREDENTIAL_EXPIRED ? 'the credential expired' : `the server closed it with code ${code}`
  return new NarsilError(ClientErrorCodes.CLIENT_CONNECTION_FAILED, `The change feed ended because ${why}`, {
    closeCode: code,
    reason,
  })
}

function subscribeMessage(options: ChangeFeedOptions): Record<string, unknown> {
  const { epoch, positions, filter } = options
  if ((epoch === undefined) !== (positions === undefined)) {
    throw new NarsilError(ErrorCodes.CHANGES_INVALID_POSITIONS, 'Pass epoch and positions together, or leave both out')
  }
  return { type: 'subscribe', epoch, positions, filter }
}

export function openChangeSubscription(url: string, options: ChangeFeedOptions): ChangeSubscription {
  if (typeof WebSocket === 'undefined') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The change feed needs a runtime with a global WebSocket')
  }
  const subscribe = subscribeMessage(options)
  const queue: ChangesEvent[] = []
  let failure: NarsilError | null = null
  let ended = false
  let iterating = false
  let wake: (() => void) | null = null
  let socket: WebSocket | null = null
  let codec: MessagePackCode | null = null
  let partitionCount = 0
  const saved: number[] = []

  const notify = (): void => {
    const waiting = wake
    wake = null
    waiting?.()
  }

  function finish(error: NarsilError | null): void {
    if (ended) return
    ended = true
    failure = error
    options.signal?.removeEventListener('abort', close)
    if (socket !== null && socket.readyState <= WebSocket.OPEN) socket.close(CLOSE_NORMAL, 'subscriber closed')
    notify()
  }

  function close(): void {
    finish(null)
  }

  function receive(data: unknown, code: MessagePackCode): void {
    if (!(data instanceof ArrayBuffer)) {
      finish(new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, 'The change feed sent a text frame'))
      return
    }
    try {
      const raw = code.decode(new Uint8Array(data))
      if (partitionCount === 0) {
        const { event } = subscribedOf(raw)
        if (event.type === 'subscribed') {
          partitionCount = event.partitionCount
          saved.push(...new Array<number>(partitionCount).fill(0))
          for (const position of event.positions) saved[position.partitionId] = position.seqNo
        }
        queue.push(event)
      } else {
        const event = laterEventOf(raw, partitionCount)
        queue.push(event)
        if (event.type === 'resync') {
          finish(null)
          return
        }
      }
    } catch (error) {
      finish(
        error instanceof NarsilError
          ? error
          : new NarsilError(
              ClientErrorCodes.CLIENT_INVALID_RESPONSE,
              'The change feed sent a message that is not MessagePack',
              { cause: error instanceof Error ? error.message : String(error) },
            ),
      )
      return
    }
    notify()
  }

  function connect(code: MessagePackCode): void {
    codec = code
    if (ended) return
    const protocols =
      options.credential === undefined ? [CHANGES_SUBPROTOCOL] : [CHANGES_SUBPROTOCOL, options.credential]
    let opened: WebSocket
    try {
      opened = new WebSocket(url, protocols)
    } catch (error) {
      finish(
        new NarsilError(ErrorCodes.CONFIG_INVALID, 'The change feed could not start a WebSocket connection', {
          cause: error instanceof Error ? error.message : String(error),
        }),
      )
      return
    }
    socket = opened
    opened.binaryType = 'arraybuffer'
    opened.onopen = () => {
      if (opened.protocol !== CHANGES_SUBPROTOCOL) {
        finish(
          new NarsilError(
            ClientErrorCodes.CLIENT_INVALID_RESPONSE,
            `The server answered the change feed with the subprotocol "${opened.protocol}"`,
          ),
        )
        return
      }
      opened.send(code.encode(subscribe, { ignoreUndefined: true }))
    }
    opened.onmessage = event => {
      if (!ended) receive(event.data, code)
    }
    opened.onerror = () => {
      if (!ended) finish(new NarsilError(ClientErrorCodes.CLIENT_CONNECTION_FAILED, `The change feed at ${url} failed`))
    }
    opened.onclose = event => {
      if (!ended) finish(closedError(event.code, event.reason))
    }
  }

  if (options.signal?.aborted === true) ended = true
  else options.signal?.addEventListener('abort', close)
  if (!ended) {
    loadMessagePack().then(connect, (error: unknown) =>
      finish(
        error instanceof NarsilError ? error : new NarsilError(ClientErrorCodes.CLIENT_UNEXPECTED_ERROR, String(error)),
      ),
    )
  }

  async function* events(): AsyncGenerator<ChangesEvent, void, undefined> {
    try {
      while (true) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (ended) {
          if (failure !== null) throw failure
          return
        }
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    } finally {
      close()
    }
  }

  return {
    [Symbol.asyncIterator]() {
      if (iterating) {
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A change subscription returns its events to one loop alone')
      }
      iterating = true
      return events()
    },
    ack(positions) {
      for (const { partitionId, seqNo } of positions) {
        if (!Number.isSafeInteger(partitionId) || partitionId < 0 || !Number.isSafeInteger(seqNo) || seqNo < 0) {
          throw new NarsilError(
            ErrorCodes.CHANGES_INVALID_POSITIONS,
            'Each acknowledged position needs whole numbers',
            {
              partitionId,
              seqNo,
            },
          )
        }
        if (saved.length > 0 && partitionId >= saved.length) {
          throw new NarsilError(ErrorCodes.CHANGES_INVALID_POSITIONS, 'The index has no such partition', {
            partitionId,
            partitionCount,
          })
        }
      }
      if (ended || socket === null || codec === null || socket.readyState !== WebSocket.OPEN) return
      if (saved.length === 0) return
      for (const { partitionId, seqNo } of positions) saved[partitionId] = Math.max(saved[partitionId] ?? 0, seqNo)
      const every = saved.map((seqNo, partitionId) => ({ partitionId, seqNo }))
      socket.send(codec.encode({ type: 'ack', positions: every }))
    },
    close,
  }
}
