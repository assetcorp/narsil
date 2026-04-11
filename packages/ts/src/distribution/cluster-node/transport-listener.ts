import {
  ClusterMessageTypes,
  type NodeTransport,
  ReplicationMessageTypes,
  type TransportMessage,
} from '../transport/types'

export type TransportHandler = (
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
) => void | Promise<void>

export interface MultiplexedControllerTransport {
  transport: NodeTransport
  createHandler: (dataHandler: TransportHandler) => TransportHandler
}

const CONTROLLER_MESSAGE_TYPES = new Set<string>([
  ReplicationMessageTypes.INSYNC_REMOVE,
  ClusterMessageTypes.BOOTSTRAP_COMPLETE,
])

export function createMultiplexedControllerTransport(baseTransport: NodeTransport): MultiplexedControllerTransport {
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
          if (controllerHandler !== null) {
            await controllerHandler(message, createSingleResponseRespond(respond))
          }
          return
        }
        await dataHandler(message, respond)
      }
    },
  }
}

function createSingleResponseRespond(
  respond: (response: TransportMessage) => void,
): (response: TransportMessage) => void {
  let delivered = false
  return (response: TransportMessage) => {
    if (delivered) {
      return
    }
    delivered = true
    respond(response)
  }
}
