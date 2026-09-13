import { ErrorCodes, NarsilError } from '../../errors'

/**
 * Reads full-precision vectors by position out of the vector files a
 * checkpoint wrote. A browser has no such file, so every read fails.
 *
 * @internal
 */
export interface VectorFileReader {
  readInto(path: string, offset: number, target: Uint8Array): boolean
  retainOnly(paths: ReadonlySet<string>): void
  close(): void
}

function filesystemUnavailable(): never {
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    'Reading vectors from a checkpoint file requires a Node.js runtime; keep the field in memory in the browser',
  )
}

/**
 * Builds a reader that refuses every read, because the runtime has no file
 * to read by position.
 *
 * @returns The reader.
 *
 * @internal
 */
export function createVectorFileReader(): VectorFileReader {
  return {
    readInto: () => filesystemUnavailable(),
    retainOnly: () => undefined,
    close: () => undefined,
  }
}
