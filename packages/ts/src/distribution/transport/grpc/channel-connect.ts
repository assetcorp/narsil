import type { Client } from '@grpc/grpc-js'
import { TransportError, TransportErrorCodes } from '../types'
import type { GrpcModule } from './loader'
import { sendMethod } from './service'

const CONNECT_PROBE_PATH = '/narsil.transport.v1.ConnectProbe/LastError'
const LAST_ERROR_PATTERN = /Last error: (?:Error: )?(.*?)\. Resolution note:/s

export interface ChannelConnect {
  ready: Promise<void>
  cancel(): void
}

export function connectFailed(target: string, reason: string): TransportError {
  return new TransportError(TransportErrorCodes.CONNECT_FAILED, `Failed to connect to '${target}': ${reason}`, {
    target,
  })
}

function lastErrorIn(details: string): string {
  return LAST_ERROR_PATTERN.exec(details)?.[1] ?? (details === '' ? 'the channel failed to connect' : details)
}

export function connectChannel(
  grpc: GrpcModule,
  client: Client,
  target: string,
  connectTimeout: number,
): ChannelConnect {
  const deadline = Date.now() + connectTimeout
  let cancel = (): void => undefined

  const ready = new Promise<void>((resolve, reject) => {
    const { READY, SHUTDOWN, TRANSIENT_FAILURE } = grpc.connectivityState
    let settled = false
    let probe: { cancel(): void } | undefined

    const fail = (reason: string): void => {
      if (settled) return
      settled = true
      reject(connectFailed(target, reason))
      probe?.cancel()
      client.close()
    }
    cancel = () => {
      fail('the transport shut down')
    }

    const check = (deadlinePassed?: Error): void => {
      if (settled) return
      if (deadlinePassed !== undefined) {
        fail(`no connection was ready within ${connectTimeout}ms`)
        return
      }
      try {
        const channel = client.getChannel()
        const state = channel.getConnectivityState(true)
        if (state === READY) {
          settled = true
          resolve()
        } else if (state === TRANSIENT_FAILURE) {
          probe = client.makeUnaryRequest(
            CONNECT_PROBE_PATH,
            sendMethod.requestSerialize,
            sendMethod.responseDeserialize,
            new Uint8Array(0),
            new grpc.Metadata(),
            { deadline },
            error => {
              fail(lastErrorIn(error?.details ?? ''))
            },
          )
        } else if (state === SHUTDOWN) {
          fail('the channel shut down')
        } else {
          channel.watchConnectivityState(state, deadline, check)
        }
      } catch {
        fail('the channel closed')
      }
    }
    check()
  })

  return { ready, cancel: () => cancel() }
}
