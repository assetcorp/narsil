import { V8_YOUNG_GENERATION_BYTES_BY_MAJOR } from './constants'

const MEGABYTE_BYTES = 1_048_576

interface ExitingThread {
  once(event: 'exit', listener: () => void): unknown
}

let threadYoungGenerationBytes = 0

export function youngGenerationBytesOfThisV8(): number {
  const major = Number(globalThis.process?.versions?.v8?.split('.')[0])
  return V8_YOUNG_GENERATION_BYTES_BY_MAJOR[major] ?? Math.max(...Object.values(V8_YOUNG_GENERATION_BYTES_BY_MAJOR))
}

export function countEngineThread(thread: ExitingThread, youngGenerationMb: number | undefined): void {
  const bytes = youngGenerationMb === undefined ? youngGenerationBytesOfThisV8() : youngGenerationMb * MEGABYTE_BYTES
  threadYoungGenerationBytes += bytes
  thread.once('exit', () => {
    threadYoungGenerationBytes -= bytes
  })
}

export function engineThreadYoungGenerationBytes(): number {
  return threadYoungGenerationBytes
}
