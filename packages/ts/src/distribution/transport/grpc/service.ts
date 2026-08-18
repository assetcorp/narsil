import type { MethodDefinition } from '@grpc/grpc-js'
import { decodeBytesMessage, encodeBytesMessage } from './codec'

export const SEND_METHOD_PATH = '/narsil.transport.v1.NodeTransport/Send'
export const OPEN_STREAM_METHOD_PATH = '/narsil.transport.v1.NodeTransport/OpenStream'

function serializeBytes(value: Uint8Array): Buffer {
  return encodeBytesMessage(value)
}

function deserializeBytes(value: Buffer): Uint8Array {
  return decodeBytesMessage(value)
}

export const sendMethod: MethodDefinition<Uint8Array, Uint8Array> = {
  path: SEND_METHOD_PATH,
  requestStream: false,
  responseStream: false,
  requestSerialize: serializeBytes,
  requestDeserialize: deserializeBytes,
  responseSerialize: serializeBytes,
  responseDeserialize: deserializeBytes,
}

export const openStreamMethod: MethodDefinition<Uint8Array, Uint8Array> = {
  path: OPEN_STREAM_METHOD_PATH,
  requestStream: false,
  responseStream: true,
  requestSerialize: serializeBytes,
  requestDeserialize: deserializeBytes,
  responseSerialize: serializeBytes,
  responseDeserialize: deserializeBytes,
}

export const nodeTransportService = {
  send: sendMethod,
  openStream: openStreamMethod,
}
