import { ErrorCodes, NarsilError } from '../../errors'

export function localIndexIsGone(err: unknown): boolean {
  return (
    err instanceof NarsilError &&
    (err.code === ErrorCodes.INDEX_NOT_FOUND || err.code === ErrorCodes.INSTANCE_SHUT_DOWN)
  )
}
