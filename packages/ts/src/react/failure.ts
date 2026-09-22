import { ClientErrorCodes, isNarsilError, NarsilError } from '../errors'

/**
 * Turns whatever a client call threw into a `NarsilError`, so that a hook
 * always reports one.
 *
 * Every client method throws a `NarsilError` already, under the code that the
 * server sends or under one of the client's own. This function returns such an
 * error unchanged even though the client bundle holds its own copy of the
 * class, because it tests for the marker that every `NarsilError` constructor
 * writes. Any other value comes from a fault on this side, so it comes back
 * under `CLIENT_UNEXPECTED_ERROR` and never under a code that would blame a
 * server that the request may never have reached.
 *
 * @param err - This is the value the call threw.
 * @param whatFailed - This names the work for the message, such as `The import`.
 * @returns The failure carries a code a caller can branch on.
 */
export function asNarsilError(err: unknown, whatFailed: string): NarsilError {
  if (isNarsilError(err)) return err
  const message = err instanceof Error ? err.message : String(err)
  return new NarsilError(ClientErrorCodes.CLIENT_UNEXPECTED_ERROR, `${whatFailed} failed unexpectedly: ${message}`)
}
