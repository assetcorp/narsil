export interface DurableWriteGate {
  admit(indexName: string): Promise<void> | undefined
  finish(indexName: string): void
  hold(indexName: string): Promise<() => void>
}

export function createWriteGate(): DurableWriteGate {
  const closed = new Map<string, Promise<void>>()
  const writing = new Map<string, number>()
  const drained = new Map<string, () => void>()

  function enter(indexName: string): void {
    writing.set(indexName, (writing.get(indexName) ?? 0) + 1)
  }

  async function admitOnceOpen(indexName: string): Promise<void> {
    let gate = closed.get(indexName)
    while (gate !== undefined) {
      await gate
      gate = closed.get(indexName)
    }
    enter(indexName)
  }

  function finish(indexName: string): void {
    const left = (writing.get(indexName) ?? 0) - 1
    if (left > 0) {
      writing.set(indexName, left)
      return
    }
    writing.delete(indexName)
    const notify = drained.get(indexName)
    drained.delete(indexName)
    notify?.()
  }

  async function hold(indexName: string): Promise<() => void> {
    let earlier = closed.get(indexName)
    while (earlier !== undefined) {
      await earlier
      earlier = closed.get(indexName)
    }
    let open: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      open = resolve
    })
    closed.set(indexName, gate)
    if ((writing.get(indexName) ?? 0) > 0) {
      await new Promise<void>(resolve => {
        drained.set(indexName, resolve)
      })
    }
    return () => {
      if (closed.get(indexName) === gate) closed.delete(indexName)
      open()
    }
  }

  return {
    admit(indexName) {
      if (!closed.has(indexName)) {
        enter(indexName)
        return undefined
      }
      return admitOnceOpen(indexName)
    },
    finish,
    hold,
  }
}
