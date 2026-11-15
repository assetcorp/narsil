import { UNADDRESSABLE_TARGET_DETAIL } from '../constants'
import { TransportError, TransportErrorCodes } from '../types'

export function parseAddress(address: string): [string, string] {
  const lastColon = address.lastIndexOf(':')
  if (lastColon === -1) {
    throw new TransportError(
      TransportErrorCodes.CONNECT_FAILED,
      `Invalid address format '${address}', expected host:port`,
      {
        address,
        [UNADDRESSABLE_TARGET_DETAIL]: true,
      },
    )
  }
  const host = address.slice(0, lastColon)
  const port = address.slice(lastColon + 1)
  if (host.length === 0 || host.includes('\0')) {
    throw new TransportError(TransportErrorCodes.CONNECT_FAILED, `Invalid host in address '${address}'`, {
      address,
      [UNADDRESSABLE_TARGET_DETAIL]: true,
    })
  }
  return [host, port]
}
