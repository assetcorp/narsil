import { bindSignalStop } from '../core/search-stop'
import type { ResponseAbort } from './request'

const stops = new WeakMap<ResponseAbort, Uint32Array<SharedArrayBuffer>>()

export function bindResponseStop(abort: ResponseAbort, buffer: SharedArrayBuffer): void {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== Uint32Array.BYTES_PER_ELEMENT)
    throw new TypeError('A search stop flag requires one shared uint32 word')
  const stop = new Uint32Array(buffer)
  stops.set(abort, stop)
  abort.onAbort(() => Atomics.store(stop, 0, 1))
}

export function stopResponse(abort: ResponseAbort): void {
  const stop = stops.get(abort)
  if (stop !== undefined) Atomics.store(stop, 0, 1)
}

export function responseStopOf(abort: ResponseAbort): Uint32Array<SharedArrayBuffer> {
  let stop = stops.get(abort)
  if (stop === undefined) {
    stop = new Uint32Array(new SharedArrayBuffer(4))
    bindResponseStop(abort, stop.buffer)
  }
  return stop
}

export function requestSignal(abort: ResponseAbort): AbortSignal {
  const controller = new AbortController()
  bindSignalStop(controller.signal, responseStopOf(abort))
  abort.onAbort(() => controller.abort())
  return controller.signal
}
