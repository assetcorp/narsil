import { isIP } from 'node:net'
import type { CallCredentials, ChannelCredentials, ChannelOptions, experimental } from '@grpc/grpc-js'
import type { GrpcModule } from './loader'

type SecureConnector = ReturnType<ChannelCredentials['_createSecureConnector']>

interface HeldConnectionOptions {
  connectionOptions?: { servername?: unknown }
}

function dropIpServerName(connector: SecureConnector): SecureConnector {
  const held = (connector as unknown as HeldConnectionOptions).connectionOptions
  if (held !== undefined && typeof held.servername === 'string' && isIP(held.servername) !== 0) {
    delete held.servername
  }
  return connector
}

export function withoutIpServerName(grpc: GrpcModule, inner: ChannelCredentials): ChannelCredentials {
  class IpAwareCredentials extends grpc.ChannelCredentials {
    _isSecure(): boolean {
      return inner._isSecure()
    }

    _equals(other: ChannelCredentials): boolean {
      return other === this
    }

    _createSecureConnector(
      channelTarget: experimental.GrpcUri,
      options: ChannelOptions,
      callCredentials?: CallCredentials,
    ): SecureConnector {
      return dropIpServerName(inner._createSecureConnector(channelTarget, options, callCredentials))
    }
  }
  return new IpAwareCredentials()
}
