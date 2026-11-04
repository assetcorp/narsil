import {
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  ReadableByteStreamController,
  ReadableStream,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
} from 'web-streams-polyfill'

const STREAM_CLASSES: Readonly<Record<string, unknown>> = {
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  ReadableByteStreamController,
  ReadableStream,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
}

export function installStreams(): void {
  const scope = globalThis as Record<string, unknown>
  if (typeof scope.ReadableStream === 'function') return
  for (const [name, streamClass] of Object.entries(STREAM_CLASSES)) {
    if (scope[name] !== undefined) continue
    Object.defineProperty(globalThis, name, {
      value: streamClass,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }
}
