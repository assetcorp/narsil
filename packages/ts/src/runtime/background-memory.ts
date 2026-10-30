export type BackgroundAdmission = (bytes: number) => boolean

export interface WaitingWork {
  indexName: string
  fieldName: string
}

const admissions = new Set<BackgroundAdmission>()
const waiting = new Map<object, WaitingWork>()

export function addBackgroundAdmission(admission: BackgroundAdmission): () => void {
  admissions.add(admission)
  return () => {
    admissions.delete(admission)
  }
}

export function admitsBackgroundBytes(bytes: number): boolean {
  for (const admission of admissions) {
    if (!admission(bytes)) return false
  }
  return true
}

export function noteWaitingForMemory(owner: object, work: WaitingWork | null): void {
  if (work === null) waiting.delete(owner)
  else waiting.set(owner, work)
}

export function workWaitingForMemory(): WaitingWork[] {
  return [...waiting.values()]
}
