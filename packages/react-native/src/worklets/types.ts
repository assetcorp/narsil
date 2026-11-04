import type { DurabilityConfig, NarsilConfig } from '@delali/narsil'

/**
 * The engine settings that an app passes to the engine on its own Worklets
 * runtime. Each value has to cross to that runtime as data, so the settings
 * that hold a function, such as an embedding adapter or a plugin, go in an
 * {@link EngineSetup} worklet instead.
 *
 * `durability` defaults to a write-ahead log in a `narsil` directory inside
 * the app's private storage, and `null` keeps the index in memory alone. A
 * relative `directory` resolves against that private storage.
 *
 * @public
 */
export type WorkletNarsilConfig = Omit<
  NarsilConfig,
  | 'persistence'
  | 'invalidation'
  | 'plugins'
  | 'idGenerator'
  | 'embedding'
  | 'embeddingAdapters'
  | 'rerankAdapters'
  | 'events'
  | 'durability'
> & { durability?: DurabilityConfig | null }

/**
 * A worklet that runs on the engine's runtime before the engine starts, and
 * returns the settings that hold functions, such as `embeddingAdapters`,
 * `plugins`, or `idGenerator`. Its values override the matching values of
 * {@link WorkletNarsilConfig}. Mark the function with the `'worklet'`
 * directive, and register a language or a tokenizer inside it.
 *
 * @public
 */
export type EngineSetup = () => Partial<NarsilConfig> | Promise<Partial<NarsilConfig>>
