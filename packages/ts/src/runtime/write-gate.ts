export interface WriteGate {
  enter<T>(write: () => Promise<T>): Promise<T>
  hold<T>(read: () => Promise<T>): Promise<T>
}

export function createWriteGate(): WriteGate {
  let holders = 0
  let reopened: Promise<void> = Promise.resolve()
  let reopen: () => void = () => undefined

  async function enter<T>(write: () => Promise<T>): Promise<T> {
    while (holders > 0) await reopened
    return write()
  }

  async function hold<T>(read: () => Promise<T>): Promise<T> {
    if (holders === 0) {
      reopened = new Promise(resolve => {
        reopen = resolve
      })
    }
    holders += 1
    try {
      return await read()
    } finally {
      holders -= 1
      if (holders === 0) reopen()
    }
  }

  return { enter, hold }
}
