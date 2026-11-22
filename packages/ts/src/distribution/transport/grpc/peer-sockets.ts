import type { Socket } from 'node:net'
import type { ChannelCredentials } from '@grpc/grpc-js'

type Connector = ReturnType<ChannelCredentials['_createSecureConnector']>

export class PeerSockets {
  private readonly open = new Map<Socket, Promise<void>>()

  closingOnRelease(credentials: ChannelCredentials): ChannelCredentials {
    const createConnector = credentials._createSecureConnector.bind(credentials)
    credentials._createSecureConnector = (...settings) => this.releasable(createConnector(...settings))
    return credentials
  }

  async closeAll(): Promise<void> {
    const closing = [...this.open]
    for (const [socket] of closing) socket.destroy()
    await Promise.all(closing.map(([, closed]) => closed))
  }

  private releasable(connector: Connector): Connector {
    let released = false
    let dialled: Socket | undefined
    return {
      waitForReady: () => connector.waitForReady(),
      getCallCredentials: () => connector.getCallCredentials(),
      connect: async socket => {
        if (released) throw new Error('The connection was released before it was ready')
        dialled = socket
        this.track(socket)
        const connected = await connector.connect(socket)
        if (connected.socket !== socket) connected.socket.once('close', () => socket.destroy())
        return connected
      },
      destroy: () => {
        released = true
        dialled?.destroy()
        connector.destroy()
      },
    }
  }

  private track(socket: Socket): void {
    if (socket.destroyed) return
    const closed = new Promise<void>(resolve => {
      socket.once('close', () => {
        this.open.delete(socket)
        resolve()
      })
    })
    this.open.set(socket, closed)
  }
}
