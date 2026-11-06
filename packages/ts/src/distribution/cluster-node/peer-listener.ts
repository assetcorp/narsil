import { type RespondFn, SuggestionMessageTypes, type TransportMessage } from '../transport/types'
import { createDataNodeHandler, type DataNodeHandlerDeps } from './message-handler'
import { releaseContextsOfDepartedNodes } from './search-contexts'
import { createNotReadyHandler, type MultiplexedControllerTransport } from './transport-listener'
import type { ClusterNodeConfig } from './types'

export interface PeerListenerDeps {
  config: ClusterNodeConfig
  nodeId: string
  hasControllerRole: boolean
  controllerTransport: MultiplexedControllerTransport | null
  dataHandler: DataNodeHandlerDeps | null
  answerQueryCounts(message: TransportMessage, respond: RespondFn): Promise<void>
}

export async function listenUntilJoined(
  config: ClusterNodeConfig,
  nodeId: string,
  hasDataRole: boolean,
): Promise<(() => void) | null> {
  return hasDataRole ? config.transport.listen(createNotReadyHandler(nodeId)) : null
}

export async function listenForPeers(deps: PeerListenerDeps): Promise<() => void> {
  const { config, dataHandler } = deps
  if (dataHandler === null) {
    if (deps.hasControllerRole) return () => undefined
    const notReady = createNotReadyHandler(deps.nodeId)
    return config.transport.listen((message, respond) =>
      message.type === SuggestionMessageTypes.COUNTS
        ? deps.answerQueryCounts(message, respond)
        : notReady(message, respond),
    )
  }
  const handler = createDataNodeHandler({ ...dataHandler, answerQueryCounts: deps.answerQueryCounts })
  const listener = deps.controllerTransport !== null ? deps.controllerTransport.createHandler(handler) : handler
  const unregister = await config.transport.listen(listener)
  const { searchContexts } = dataHandler
  const unwatchDepartures =
    searchContexts === undefined ? null : await releaseContextsOfDepartedNodes(config.coordinator, searchContexts)
  return () => {
    unregister()
    unwatchDepartures?.()
  }
}
