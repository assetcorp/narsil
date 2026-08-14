import { NarsilError, ServerErrorCodes } from '../errors'

/**
 * Turns whatever a client call threw into a `NarsilError`, so that a hook
 * always reports one.
 *
 * Every client method throws a `NarsilError` already, under the code the server
 * sent or under one of the client's own. Anything else reaching here came from
 * a fault inside the library rather than from a request, which is what
 * `INTERNAL_ERROR` says.
 *
 * @param err - This is the value the call threw.
 * @param whatFailed - This names the work for the message, such as `The import`.
 * @returns The failure carries a code a caller can branch on.
 */
export function asNarsilError(err: unknown, whatFailed: string): NarsilError {
  if (err instanceof NarsilError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new NarsilError(ServerErrorCodes.INTERNAL_ERROR, `${whatFailed} failed unexpectedly: ${message}`)
}
