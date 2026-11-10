class FusionMemory {
  private capacity = 0
  private words = Array.from({ length: 4 }, () => new Uint32Array(0))
  private numbers = Array.from({ length: 3 }, () => new Float64Array(0))
  private keyViews: Uint32Array[] = []
  private scoreViews: Float64Array[] = []

  reserve(count: number): void {
    if (count <= this.capacity) return
    const words = Array.from({ length: 4 }, () => new Uint32Array(count))
    const numbers = Array.from({ length: 3 }, () => new Float64Array(count))
    this.words = words
    this.numbers = numbers
    this.capacity = count
    this.keyViews = []
    this.scoreViews = []
  }

  keys(region: number, count: number): Uint32Array {
    const previous = this.keyViews[region]
    if (previous?.length === count) return previous
    const view = this.words[region].subarray(0, count)
    this.keyViews[region] = view
    return view
  }

  scores(region: number, count: number): Float64Array {
    const previous = this.scoreViews[region]
    if (previous?.length === count) return previous
    const view = this.numbers[region].subarray(0, count)
    this.scoreViews[region] = view
    return view
  }
}

let available: FusionMemory | undefined

export function takeFusionMemory(count: number): FusionMemory {
  const memory = available ?? new FusionMemory()
  available = undefined
  memory.reserve(count)
  return memory
}

export function releaseFusionMemory(memory: FusionMemory): void {
  available = memory
}
