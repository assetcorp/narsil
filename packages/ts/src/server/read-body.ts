import type { BodyBudgetRefusal, BodyHold } from './body-budget'
import { ServerErrorCodes } from './errors'
import { bodyRefusalOf, type ParsedBodyKind, type ParseRefusal } from './parse-heap'
import type { ResponseAbort } from './request'
import { type ResponseSink, sendError } from './response'

const REQUEST_BYTES_IN_FLIGHT_REASON = 'request_bytes_in_flight'

function bodyWithRoomFor(body: Buffer, filled: number, needed: number, maxBytes: number): Buffer {
  if (needed <= body.length) return body
  const grown = Buffer.allocUnsafeSlow(Math.min(maxBytes, Math.max(needed, body.length * 2)))
  grown.set(body.subarray(0, filled))
  return grown
}

function bodyOfExactly(body: Buffer, filled: number): Buffer {
  if (filled === body.length) return body
  const exact = Buffer.allocUnsafeSlow(filled)
  exact.set(body.subarray(0, filled))
  return exact
}

const NO_BYTES = new Uint8Array(0)

export type BodyKindOf = (prefix: Uint8Array) => ParsedBodyKind | null

export class RefusedBody extends Error {
  constructor(readonly refusal: ParseRefusal) {
    super(refusal.message)
  }
}

function refuseBodyBytes(res: ResponseSink, refusal: BodyBudgetRefusal): void {
  sendError(
    res,
    429,
    ServerErrorCodes.TOO_MANY_REQUESTS,
    `The server is holding ${refusal.inFlightBytes} bytes of other request bodies, and this body's ${refusal.requestBytes} bytes would take the total past its limit of ${refusal.limitBytes} bytes. Retry once the requests in progress finish.`,
    { reason: REQUEST_BYTES_IN_FLIGHT_REASON, ...refusal },
  )
}

/** Buffers the request body, enforcing a byte ceiling. Exceeding the cap sends
 * 413 and rejects, so a single oversized body cannot grow unbounded in memory.
 * The server counts every byte against `hold` before it buffers the byte, and
 * it answers 429 where a body can take the bytes of all the bodies in flight
 * past their limit. With `kindOf`, it rejects with {@link RefusedBody} as soon
 * as the declared or counted bytes cannot fit in memory, before it buffers them. */
export function readBody(
  res: ResponseSink,
  maxBytes: number,
  abort: ResponseAbort,
  hold: BodyHold,
  declaredBytes: number | null = null,
  kindOf: BodyKindOf | null = null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (abort.aborted) {
      reject(new Error('aborted'))
      return
    }
    let done = false
    let total = 0
    let filled = 0
    let body: Buffer | null = null
    const reserved = declaredBytes !== null && declaredBytes <= maxBytes ? declaredBytes : 0
    let kind = kindOf?.(NO_BYTES) ?? null
    const memoryRefusal = kindOf === null ? null : bodyRefusalOf(reserved, kind ?? 'read')
    if (memoryRefusal !== null) {
      res.onData(() => undefined)
      reject(new RefusedBody(memoryRefusal))
      return
    }
    const refusal = hold.grow(reserved)
    if (refusal !== null) {
      refuseBodyBytes(res, refusal)
      reject(new Error('request bytes in flight'))
      return
    }
    abort.onAbort(() => {
      if (done) return
      done = true
      reject(new Error('aborted'))
    })
    res.onData((chunk, isLast) => {
      if (done || abort.aborted) return
      total += chunk.byteLength
      if (total > maxBytes) {
        done = true
        if (!abort.aborted) {
          sendError(res, 413, ServerErrorCodes.PAYLOAD_TOO_LARGE, 'Request body exceeds the configured size limit')
        }
        reject(new Error('payload too large'))
        return
      }
      const chunkRefusal = total > hold.bytes ? hold.grow(total - hold.bytes) : null
      if (chunkRefusal !== null) {
        done = true
        if (!abort.aborted) refuseBodyBytes(res, chunkRefusal)
        reject(new Error('request bytes in flight'))
        return
      }
      const streamRefusal = kindOf !== null && declaredBytes === null ? bodyRefusalOf(total, kind ?? 'read') : null
      if (streamRefusal !== null) {
        done = true
        reject(new RefusedBody(streamRefusal))
        return
      }
      const arrived = new Uint8Array(chunk)
      const firstSize = isLast ? arrived.length : Math.max(reserved, arrived.length)
      body = bodyWithRoomFor(body ?? Buffer.allocUnsafeSlow(firstSize), filled, total, maxBytes)
      body.set(arrived, filled)
      filled = total
      if (kindOf !== null && kind === null) {
        kind = kindOf(body.subarray(0, filled))
        const kindRefusal = kind === null ? null : bodyRefusalOf(declaredBytes ?? total, kind)
        if (kindRefusal !== null) {
          done = true
          reject(new RefusedBody(kindRefusal))
          return
        }
      }
      if (isLast) {
        done = true
        resolve(bodyOfExactly(body, filled))
      }
    })
  })
}
