export interface TransferredError {
  transferredError: true
  name: string
  message: string
  code: string | undefined
  details: unknown
}

export type CallOutcome = { ok: true; value: unknown } | { ok: false; error: TransferredError }

export function isTransferredError(value: unknown): value is TransferredError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { transferredError?: unknown }).transferredError === true &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}
