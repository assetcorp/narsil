interface RecordedProcess {
  pid: number
  processStartMs: number | null
}

export async function holderIsLive(
  _holder: RecordedProcess,
  _self: RecordedProcess,
  _lockPath: string,
): Promise<boolean> {
  return true
}

export function holdDirectoryOpen(_directory: string): () => void {
  return () => undefined
}

export async function removeStaleLock(
  _lockPath: string,
  _asidePath: string,
  _isStale: (text: string) => boolean,
): Promise<void> {}
