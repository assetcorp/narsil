export function holdsAnotherIndex(localUuid: string | null | undefined, requestedUuid: unknown): boolean {
  return typeof requestedUuid === 'string' && typeof localUuid === 'string' && localUuid !== requestedUuid
}
