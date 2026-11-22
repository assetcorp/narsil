import { type ErrorCode, ErrorCodes } from '../../errors'
import { answerPing } from '../ping'
import {
  ClusterMessageTypes,
  type NodeTransport,
  ReplicationMessageTypes,
  type RespondFn,
  SuggestionMessageTypes,
  type TransportMessage,
} from '../transport/types'
import { encodeErrorReply } from './error-reply'

export type TransportHandler = (message: TransportMessage, respond: RespondFn) => void | Promise<void>

export interface MultiplexedControllerTransport {
  transport: NodeTransport
  createHandler: (dataHandler: TransportHandler) => TransportHandler
  createJoiningHandler: (notReady: TransportHandler) => TransportHandler
}

const CONTROLLER_MESSAGE_TYPES = new Set<string>([
  ReplicationMessageTypes.INSYNC_ADD,
  ReplicationMessageTypes.INSYNC_REMOVE,
  ReplicationMessageTypes.PRIMARY_RESIGN,
  ClusterMessageTypes.BOOTSTRAP_COMPLETE,
  ClusterMessageTypes.REPLICATION_FACTOR,
  ClusterMessageTypes.REBALANCE,
  ClusterMessageTypes.BACKUP,
  ClusterMessageTypes.BACKUP_RESTORE,
  ClusterMessageTypes.BACKUP_DELETE,
  SuggestionMessageTypes.BUILD,
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
    payload: encodeErrorReply(code, text, { nodeId }),
  })
}

/**
 * Builds the handler a node listens with before it has joined, which answers a `cluster.ping` with a
 * `cluster.pong` and refuses every other message it receives.
 *
 * A node opens its transport listener before it registers, so that a peer reaching it early receives a stated
 * refusal in place of a connection failure it would have to time out on.
 *
 * @param nodeId - This node's id, which names the sender of each answer.
 * @returns The handler to pass to `listen` until the node starts serving.
 */
export function createNotReadyHandler(nodeId: string): TransportHandler {
  return (message, respond) =>
    message.type === ClusterMessageTypes.PING
      ? answerPing(message, respond, nodeId)
      : refuseMessage(
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
 * the message with `NODE_NOT_CONTROLLER`, so the sender retries against the node that holds the lease. A node that
 * has yet to join listens with `createJoiningHandler`, which sends a controller message to a controller that won the
 * election early and refuses everything else as the not-ready handler does.
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
    timeouts: baseTransport.timeouts,

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
    createJoiningHandler(notReady: TransportHandler): TransportHandler {
      return (message, respond) =>
        controllerHandler !== null && CONTROLLER_MESSAGE_TYPES.has(message.type)
          ? controllerHandler(message, createSingleResponseRespond(respond))
          : notReady(message, respond)
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
