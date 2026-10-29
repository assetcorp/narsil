import { connect, createServer, type Server, type Socket } from 'node:net'

export interface LinkProxy {
  readonly port: number
  cut(): void
  heal(): void
  close(): Promise<void>
}

export async function startLinkProxy(targetPort: () => number): Promise<LinkProxy> {
  const open = new Set<Socket>()
  let isCut = false

  const server: Server = createServer(inbound => {
    if (isCut) {
      inbound.destroy()
      return
    }
    const outbound = connect(targetPort(), '127.0.0.1')
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
      isCut = true
      for (const socket of open) socket.destroy()
      open.clear()
    },
    heal() {
      isCut = false
    },
    async close() {
      isCut = true
      for (const socket of open) socket.destroy()
      open.clear()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
