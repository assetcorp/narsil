import { ErrorCodes, NarsilError } from '../../../errors'
import { ETCD_REQUEST_FRAMING_BYTES, MAX_ETCD_REQUEST_BYTES } from './constants'

type Etcd3Module = typeof import('etcd3')

const ETCD_REQUEST_TOO_LARGE = 'etcdserver: request is too large'
const GRPC_MESSAGE_TOO_LARGE = 'larger than max'

export interface EtcdWrite {
  key: string
  value: Uint8Array
  expected: Uint8Array | null
}

export interface EtcdWriteGuard {
  requireFits(write: EtcdWrite): number
  send<T>(write: EtcdWrite, perform: () => Promise<T>): Promise<T>
}

export function requireEtcdMaxRequestBytes(maxRequestBytes: number): void {
  if (
    Number.isSafeInteger(maxRequestBytes) &&
    maxRequestBytes > ETCD_REQUEST_FRAMING_BYTES &&
    maxRequestBytes <= MAX_ETCD_REQUEST_BYTES
  ) {
    return
  }
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `maxRequestBytes must be a whole number above ${ETCD_REQUEST_FRAMING_BYTES} and at most ${MAX_ETCD_REQUEST_BYTES}`,
    { maxRequestBytes },
  )
}

function requestBytesOf(write: EtcdWrite): number {
  const keyBytes = Buffer.byteLength(write.key)
  return write.value.byteLength + (write.expected?.byteLength ?? 0) + 2 * keyBytes + ETCD_REQUEST_FRAMING_BYTES
}

function refusedForSize(etcd3: Etcd3Module, error: unknown): boolean {
  if (error instanceof etcd3.GRPCInvalidArgumentError) return error.message.includes(ETCD_REQUEST_TOO_LARGE)
  if (error instanceof etcd3.GRPCResourceExhastedError) return error.message.includes(GRPC_MESSAGE_TOO_LARGE)
  return false
}

export function createEtcdWriteGuard(etcd3: Etcd3Module, maxRequestBytes: number): EtcdWriteGuard {
  function requireFits(write: EtcdWrite): number {
    const bytes = requestBytesOf(write)
    if (bytes <= maxRequestBytes) return bytes
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The request to write "${write.key}" would be ${bytes} bytes, more than the maxRequestBytes of ${maxRequestBytes}. Raise maxRequestBytes in createEtcdCoordinator together with the --max-request-bytes value of etcd.`,
      { key: write.key, bytes, maxRequestBytes },
    )
  }

  return {
    requireFits,
    async send<T>(write: EtcdWrite, perform: () => Promise<T>): Promise<T> {
      const bytes = requireFits(write)
      try {
        return await perform()
      } catch (error) {
        if (!refusedForSize(etcd3, error)) throw error
        throw new NarsilError(
          ErrorCodes.CONFIG_INVALID,
          `etcd reports the ${bytes}-byte request to write "${write.key}" as too large, so its --max-request-bytes value is below the maxRequestBytes of ${maxRequestBytes}. Set both to the same value.`,
          { key: write.key, bytes, maxRequestBytes },
        )
      }
    },
  }
}
