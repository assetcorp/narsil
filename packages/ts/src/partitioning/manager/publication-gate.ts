export interface PublicationGate {
  read<T>(read: (release: () => void) => T | Promise<T>): Promise<T>
  write<T>(write: () => T | Promise<T>): Promise<T>
}

export interface PublicationSettlement {
  pending(): boolean
  settle(): void
}

interface Waiting {
  readonly writer: boolean
  readonly start: () => void
  next?: Waiting
}

export function createPublicationGate(settlement?: PublicationSettlement): PublicationGate {
  let readers = 0
  let writing = false
  let first: Waiting | undefined
  let last: Waiting | undefined
  let pumping = false

  function available(writer: boolean): boolean {
    if (writing) return false
    if (writer) return readers === 0
    return readers === 0 || settlement === undefined || !settlement.pending()
  }

  function pump(): void {
    if (pumping) return
    pumping = true
    try {
      while (first !== undefined) {
        const next = first
        if (!available(next.writer)) return
        first = next.next
        next.next = undefined
        if (first === undefined) last = undefined
        next.start()
      }
    } finally {
      pumping = false
    }
  }

  async function start<T>(writer: boolean, work: (release: () => void) => T | Promise<T>): Promise<T> {
    if (!writer && readers === 0) settlement?.settle()
    if (writer) writing = true
    else readers++
    let held = true
    const release = (): void => {
      if (!held) return
      held = false
      if (writer) writing = false
      else readers--
      pump()
    }
    try {
      const result = work(release)
      return result === undefined ? result : await result
    } finally {
      release()
    }
  }

  function enter<T>(writer: boolean, work: (release: () => void) => T | Promise<T>): Promise<T> {
    if (first === undefined && available(writer)) return start(writer, work)
    return new Promise((resolve, reject) => {
      const next: Waiting = { writer, start: () => start(writer, work).then(resolve, reject) }
      if (last === undefined) first = next
      else last.next = next
      last = next
    })
  }

  return { read: read => enter(false, read), write: write => enter(true, write) }
}
