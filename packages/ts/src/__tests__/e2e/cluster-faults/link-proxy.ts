import { connect, createServer, type Server, type Socket } from 'node:net'

export interface LinkProxy {
  readonly port: number
  cut(): void
  blackhole(): void
  heal(): void
  close(): Promise<void>
}

type LinkMode = 'forward' | 'cut' | 'blackhole'

export async function startLinkProxy(targetPort: () => number): Promise<LinkProxy> {
  const open = new Set<Socket>()
  const held = new Set<Socket>()
  let mode: LinkMode = 'forward'

  function hold(inbound: Socket): void {
    held.add(inbound)
    inbound.on('data', () => {})
    inbound.on('error', () => held.delete(inbound))
    inbound.on('close', () => held.delete(inbound))
  }

  function destroyAll(): void {
    for (const socket of open) socket.destroy()
    open.clear()
    for (const socket of held) socket.destroy()
    held.clear()
  }

  const server: Server = createServer(inbound => {
    if (mode === 'cut') {
      inbound.destroy()
      return
    }
    if (mode === 'blackhole') {
      hold(inbound)
      return
    }
    let port: number
    try {
      port = targetPort()
    } catch {
      inbound.destroy()
      return
    }
    if (mode !== 'forward') {
      if (mode === 'blackhole') hold(inbound)
      else inbound.destroy()
      return
    }
    const outbound = connect(port, '127.0.0.1')
    open.add(inbound)
    open.add(outbound)
    const end = () => {
      inbound.destroy()
      outbound.destroy()
      open.delete(inbound)
      open.delete(outbound)
    }
    inbound.on('error', end)
    outbound.on('error', end)
    inbound.on('close', end)
    outbound.on('close', end)
    inbound.pipe(outbound)
    outbound.pipe(inbound)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The link proxy bound no TCP port')

  return {
    port: address.port,
    cut() {
      mode = 'cut'
      destroyAll()
    },
    blackhole() {
      mode = 'blackhole'
      destroyAll()
    },
    heal() {
      mode = 'forward'
      for (const socket of held) socket.destroy()
      held.clear()
    },
    async close() {
      mode = 'cut'
      destroyAll()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
