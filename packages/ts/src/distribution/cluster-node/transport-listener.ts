import { encode } from '@msgpack/msgpack'
import { type ErrorCode, ErrorCodes } from '../../errors'
import {
  ClusterMessageTypes,
  type NodeTransport,
  ReplicationMessageTypes,
  type RespondFn,
  type TransportMessage,
} from '../transport/types'

export type TransportHandler = (message: TransportMessage, respond: RespondFn) => void | Promise<void>

export interface MultiplexedControllerTransport {
  transport: NodeTransport
  createHandler: (dataHandler: TransportHandler) => TransportHandler
}

const CONTROLLER_MESSAGE_TYPES = new Set<string>([
  ReplicationMessageTypes.INSYNC_ADD,
  ReplicationMessageTypes.INSYNC_REMOVE,
  ClusterMessageTypes.BOOTSTRAP_COMPLETE,
])

function refuseMessage(
  nodeId: string,
  message: TransportMessage,
  respond: RespondFn,
  code: ErrorCode,
  text: string,
): Promise<void> {
  return respond({
    type: `${message.type}.error`,
    sourceId: nodeId,
    requestId: message.requestId,
    payload: encode({ error: true, code, message: text }),
  })
}

/**
 * Builds the handler a node listens with before it has joined, which refuses every message it receives.
 *
 * A node opens its transport listener before it registers, so that a peer reaching it early receives a stated
 * refusal in place of a connection failure it would have to time out on.
 *
 * @param nodeId - This node's id, which names the sender of each refusal.
 * @returns The handler to pass to `listen` until the node starts serving.
 */
export function createNotReadyHandler(nodeId: string): TransportHandler {
  return (message, respond) =>
    refuseMessage(
      nodeId,
      message,
      respond,
      ErrorCodes.NODE_NOT_READY,
      `Node '${nodeId}' has yet to finish joining the cluster, so it serves nothing`,
    )
}

/**
 * Splits one transport between the data handler and the controller on a node that may hold both roles.
 *
 * The controller listens on the returned transport, and the data node wraps its own handler with `createHandler`,
 * which sends each controller message to the controller while one is listening. While none is, the node refuses
 * the message with `NODE_NOT_CONTROLLER`, so the sender retries against the node that holds the lease.
 *
 * @param baseTransport - The transport the node was built with.
 * @param nodeId - This node's id, which names the sender of each refusal.
 * @returns The transport the controller listens on, and the function that wraps the data handler.
 */
export function createMultiplexedControllerTransport(
  baseTransport: NodeTransport,
  nodeId: string,
): MultiplexedControllerTransport {
  let controllerHandler: TransportHandler | null = null

  const transport: NodeTransport = {
    send(target: string, message: TransportMessage) {
      return baseTransport.send(target, message)
    },

    stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void) {
      return baseTransport.stream(target, message, handler)
    },

    async listen(handler: TransportHandler): Promise<() => void> {
      const previousHandler = controllerHandler
      controllerHandler = handler
      return () => {
        if (controllerHandler === handler) {
          controllerHandler = previousHandler
        }
      }
    },

    async shutdown(): Promise<void> {
      controllerHandler = null
    },
  }

  return {
    transport,
    createHandler(dataHandler: TransportHandler): TransportHandler {
      return async (message, respond) => {
        if (CONTROLLER_MESSAGE_TYPES.has(message.type)) {
          if (controllerHandler === null) {
            await refuseMessage(
              nodeId,
              message,
              respond,
              ErrorCodes.NODE_NOT_CONTROLLER,
              `Node '${nodeId}' holds no controller lease, so it answers no controller message`,
            )
            return
          }
          await controllerHandler(message, createSingleResponseRespond(respond))
          return
        }
        await dataHandler(message, respond)
      }
    },
  }
}

function createSingleResponseRespond(respond: RespondFn): RespondFn {
  let delivered = false
  return (response: TransportMessage): Promise<void> => {
    if (delivered) {
      return Promise.resolve()
    }
    delivered = true
    return respond(response)
  }
}
