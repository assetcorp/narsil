import { ErrorCodes, NarsilError } from '../../errors'

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

export function createVectorFileReader(): VectorFileReader {
  return {
    readInto: () => filesystemUnavailable(),
    retainOnly: () => undefined,
    close: () => undefined,
  }
}
