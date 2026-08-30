import { ErrorCodes, NarsilError } from '../../errors'

export type ErrorForwarder = (error: unknown) => void

/**
 * Builds the function a node reports its background failures through.
 *
 * @param onError - The caller's handler, which may be absent.
 * @returns A forwarder that wraps anything thrown in an `Error` and hands it to the caller, or drops it where the
 * caller registered no handler.
 */
export function createErrorForwarder(onError: ((error: Error) => void) | undefined): ErrorForwarder {
  return (error: unknown): void => {
    if (onError === undefined) {
      return
    }
    onError(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Builds the function the controller reports an allocation failure through, which names the index the failure
 * concerns before it reaches the caller.
 *
 * @param forwardOnError - The forwarder every node failure passes through.
 * @returns A function taking the index name and the failure.
 */
export function createAllocationErrorForwarder(
  forwardOnError: ErrorForwarder,
): (indexName: string, error: unknown) => void {
  return (indexName: string, error: unknown): void => {
    const code = error instanceof NarsilError ? error.code : ErrorCodes.ALLOCATION_FAILED
    const details = error instanceof NarsilError ? error.details : {}
    const message = error instanceof Error ? error.message : String(error)
    forwardOnError(
      new NarsilError(code, `The controller could not allocate index '${indexName}': ${message}`, {
        ...details,
        indexName,
      }),
    )
  }
}
