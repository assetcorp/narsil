import { UNADDRESSABLE_TARGET_DETAIL } from '../constants'
import { TransportError, TransportErrorCodes } from '../types'

function unaddressable(address: string, message: string): TransportError {
  return new TransportError(TransportErrorCodes.CONNECT_FAILED, message, {
    address,
    [UNADDRESSABLE_TARGET_DETAIL]: true,
  })
}

function splitHostAndPort(address: string): [string, string] {
  if (address.startsWith('[')) {
    const closing = address.indexOf(']:')
    if (closing === -1) {
      throw unaddressable(address, `Invalid address format '${address}', expected [IPv6 address]:port`)
    }
    return [address.slice(1, closing), address.slice(closing + 2)]
  }
  const lastColon = address.lastIndexOf(':')
  if (lastColon === -1) {
    throw unaddressable(address, `Invalid address format '${address}', expected host:port`)
  }
  return [address.slice(0, lastColon), address.slice(lastColon + 1)]
}

export function parseAddress(address: string): [string, string] {
  const [host, port] = splitHostAndPort(address)
  if (host.length === 0 || host.includes('\0') || host.includes('[') || host.includes(']')) {
    throw unaddressable(address, `Invalid host in address '${address}'`)
  }
  return [host, port]
}
