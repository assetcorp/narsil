import { connect, createServer, type Server, type Socket } from 'node:net'

export interface LinkProxy {
  endpoint: string
  cut(): void
  restore(): void
  close(): Promise<void>
}

export async function startLinkProxy(target: URL): Promise<LinkProxy> {
  const sockets = new Set<Socket>()
  let linkUp = true

  function track(socket: Socket): void {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  }

  const server: Server = createServer(client => {
    track(client)
    if (!linkUp) {
      client.destroy()
      return
    }
    const upstream = connect(Number(target.port), target.hostname)
    track(upstream)
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('the proxy has no port'))
      else resolve(address.port)
    })
  })

  return {
    endpoint: `http://127.0.0.1:${port}`,
    cut() {
      linkUp = false
      for (const socket of sockets) socket.destroy()
    },
    restore() {
      linkUp = true
    },
    close() {
      for (const socket of sockets) socket.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}
