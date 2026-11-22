import { connect, createServer, type Socket } from 'node:net'

export const LOOPBACK = '127.0.0.1'

export interface ReceivingSide {
  target: string
  sockets: Socket[]
  openSockets(): number
  close(): Promise<void>
}

export async function startReceivingSide(accept: (socket: Socket, position: number) => void): Promise<ReceivingSide> {
  const sockets: Socket[] = []
  const server = createServer({ noDelay: true }, socket => {
    socket.on('error', () => socket.destroy())
    sockets.push(socket)
    accept(socket, sockets.length - 1)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The receiving side has no port')
  return {
    target: `${LOOPBACK}:${address.port}`,
    sockets,
    openSockets: () => sockets.filter(socket => !socket.destroyed).length,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

export function relayTo(port: number, inbound: Socket): void {
  const outbound = connect({ host: LOOPBACK, port, noDelay: true })
  inbound.pipe(outbound)
  outbound.pipe(inbound)
  outbound.on('error', () => inbound.destroy())
  outbound.on('close', () => inbound.destroy())
  inbound.on('close', () => outbound.destroy())
}

export function failureOf(request: Promise<unknown>): Promise<unknown> {
  return request.then(
    () => 'the request succeeded',
    (error: unknown) => error,
  )
}
