export async function recordedProcessIsAlive(_pid: number, _recordedStartMs: number | null): Promise<boolean> {
  return true
}

export async function removeStaleLock(
  _lockPath: string,
  _asidePath: string,
  _isStale: (text: string) => boolean,
): Promise<void> {}
