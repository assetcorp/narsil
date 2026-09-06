/**
 * Snapshot of V8 heap usage as reported by `process.memoryUsage()`, with the
 * limit the heap may grow to. All values are bytes. `null` in environments
 * that do not expose `process.memoryUsage`, such as browsers.
 *
 * @public
 */
export interface ProcessMemoryReport {
  /** The process is using this much heap. */
  heapUsed: number
  /** V8 has reserved this much heap. */
  heapTotal: number
  /**
   * The heap may grow to this many bytes before the runtime ends the process
   * for running out of memory. Node sets it from `--max-old-space-size`, from
   * `--max-old-space-size-percentage`, or from the memory the host or the
   * container reports. `null` where the runtime cannot report it.
   */
  heapLimit: number | null
  /** The process holds this much outside the heap, such as buffers. */
  external: number
  /** The process occupies this much physical memory in total. */
  rss: number
}

/**
 * Whether one index holds worker copies at the moment
 * {@link Narsil.getMemoryStats} reads it, and how many times it has loaded
 * them again after giving them up while idle.
 *
 * @public
 */
export interface WorkerCopyReport {
  /** This names the index. */
  indexName: string
  /** This is true while every worker holds a copy of the index. */
  scaledOut: boolean
  /** The index has loaded its copies again this many times after an idle spell dropped them. */
  reloadCount: number
}

/**
 * What {@link Narsil.getMemoryStats} returns, which is what you size a host
 * from.
 *
 * @public
 */
export interface MemoryStats {
  /**
   * V8 heap usage for the host process at the moment of the call. It covers
   * the whole process, so every Narsil engine in one process returns the same
   * `process` figures from `getMemoryStats`. `null` in browsers and in any
   * runtime that does not expose `process.memoryUsage`.
   */
  process: ProcessMemoryReport | null
  /**
   * The sum of every index's {@link IndexStats.estimatedMemoryBytes} held by
   * this engine. A formula produces it, so read it as an estimate. It compares
   * engines inside one process, where `process.heapUsed` cannot tell them
   * apart.
   */
  estimatedIndexBytes: number
  /** This many indexes currently occupy engine memory. */
  openIndexCount: number
  /** This many indexes remain registered without occupying engine memory, including parked recovery failures. */
  closedIndexCount: number
  /** This counts successful index loads since this engine started. */
  reopenCount: number
  /** One entry per index, saying whether it holds worker copies now and how many times it has reloaded them. */
  workerCopies: WorkerCopyReport[]
  /**
   * Per-worker V8 heap usage once the engine has started its worker pool.
   * Empty while no worker is running.
   */
  workers: Array<{
    /** This identifies the worker within the pool. */
    workerId: number
    /** That worker is using this much heap. */
    heapUsed: number
    /** V8 has reserved this much heap in that worker. */
    heapTotal: number
    /** That worker's heap may grow to this many bytes, or `null` where its runtime cannot report it. */
    heapLimit: number | null
    /** That worker holds this much outside its heap. */
    external: number
  }>
}
