import type { NarsilPlugin } from '../../types/plugins'

export interface SearchHold {
  readonly plugin: NarsilPlugin
  hold(count: number): Promise<void>
  release(): void
}

export function createSearchHold(): SearchHold {
  let expected = 0
  let waiting = 0
  let reached: () => void = () => undefined
  let opened: Promise<void> = Promise.resolve()
  let open: () => void = () => undefined

  return {
    plugin: {
      name: 'search-hold',
      async beforeSearch() {
        if (waiting >= expected) return
        waiting++
        const held = opened
        if (waiting === expected) reached()
        await held
      },
    },
    hold(count: number): Promise<void> {
      expected = count
      waiting = 0
      opened = new Promise(resolve => {
        open = resolve
      })
      return new Promise(resolve => {
        reached = resolve
      })
    },
    release(): void {
      expected = 0
      open()
    },
  }
}
