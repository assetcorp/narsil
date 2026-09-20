import { describe, expect, it } from 'vitest'
import { readBody } from '../../server/request'
import type { ResponseSink } from '../../server/response'

const NO_ABORT = { aborted: false, onAbort: () => undefined }
const MAX_BYTES = 1024 * 1024

interface FakeRequest {
  sink: ResponseSink
  deliver(bytes: number[], isLast: boolean): void
}

function fakeRequest(): FakeRequest {
  let onData: (chunk: ArrayBuffer, isLast: boolean) => void = () => undefined
  const sink = {
    onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void) {
      onData = handler
      return sink
    },
  } as unknown as ResponseSink
  return {
    sink,
    deliver(bytes, isLast) {
      const chunk = Uint8Array.from(bytes)
      onData(chunk.buffer, isLast)
      chunk.fill(0)
    },
  }
}

function ownsItsMemory(body: Buffer): boolean {
  return body.byteOffset === 0 && body.byteLength === body.buffer.byteLength
}

describe('reading a request body', () => {
  it('collects a body of the declared length into memory that the body owns', async () => {
    const request = fakeRequest()
    const body = readBody(request.sink, MAX_BYTES, NO_ABORT, 5)
    request.deliver([1, 2, 3], false)
    request.deliver([4, 5], true)

    const bytes = await body

    expect([...bytes]).toEqual([1, 2, 3, 4, 5])
    expect(ownsItsMemory(bytes)).toBe(true)
  })

  it('collects a body that declares no length into memory that the body owns', async () => {
    const request = fakeRequest()
    const body = readBody(request.sink, MAX_BYTES, NO_ABORT, null)
    request.deliver([1, 2, 3], false)
    request.deliver([4, 5], true)

    const bytes = await body

    expect([...bytes]).toEqual([1, 2, 3, 4, 5])
    expect(ownsItsMemory(bytes)).toBe(true)
  })

  it('keeps every byte of a body longer than its declared length', async () => {
    const request = fakeRequest()
    const body = readBody(request.sink, MAX_BYTES, NO_ABORT, 2)
    request.deliver([1, 2, 3], false)
    request.deliver([4, 5], true)

    expect([...(await body)]).toEqual([1, 2, 3, 4, 5])
  })

  it('returns only the bytes that arrived where the body is shorter than its declared length', async () => {
    const request = fakeRequest()
    const body = readBody(request.sink, MAX_BYTES, NO_ABORT, 9)
    request.deliver([1, 2, 3], true)

    expect([...(await body)]).toEqual([1, 2, 3])
  })

  it('reserves no memory for a declared length above the byte ceiling', async () => {
    const request = fakeRequest()
    const body = readBody(request.sink, 4, NO_ABORT, 1024 * 1024 * 1024)
    request.deliver([1, 2, 3], true)

    expect([...(await body)]).toEqual([1, 2, 3])
  })
})
