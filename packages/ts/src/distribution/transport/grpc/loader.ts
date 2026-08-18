import { ErrorCodes, NarsilError } from '../../../errors'

export type GrpcModule = typeof import('@grpc/grpc-js')

export async function loadGrpcModule(): Promise<GrpcModule> {
  try {
    return await import('@grpc/grpc-js')
  } catch (err) {
    throw new NarsilError(
      ErrorCodes.TRANSPORT_DEPENDENCY_MISSING,
      'The `@grpc/grpc-js` package is not installed. Install it with `pnpm add @grpc/grpc-js` (or the npm or yarn equivalent) to use createGrpcTransport.',
      { cause: err instanceof Error ? err.message : String(err) },
    )
  }
}
