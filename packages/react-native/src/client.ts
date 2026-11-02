import { createNarsil as createEngine, type Narsil, type ReactNativeHost } from '@delali/narsil'
import { installEngineHost, installedHost } from './engine/install'
import { callStreamed, withPhoneDurability } from './engine/streamed'
import { FORWARDED_METHODS, STREAMED_METHODS } from './methods'
import { loadNativeObjects } from './native-objects'
import type { PhoneNarsil, PhoneNarsilConfig } from './types'

function phoneNarsil(narsil: Narsil, host: ReactNativeHost): PhoneNarsil {
  const client: Record<string, unknown> = {}
  for (const method of FORWARDED_METHODS) {
    const target = narsil[method] as (...values: unknown[]) => unknown
    client[method] = async (...args: unknown[]) => target.apply(narsil, args)
  }
  for (const method of STREAMED_METHODS) {
    client[method] = async (...args: unknown[]) => callStreamed(narsil, host, method, args)
  }
  client.on = narsil.on.bind(narsil)
  client.off = narsil.off.bind(narsil)
  client.shutdown = async () => narsil.shutdown()
  return client as unknown as PhoneNarsil
}

/**
 * Starts a Narsil engine on the app's own JS runtime and resolves with a
 * client whose methods each return a promise. The engine takes the same
 * settings as on Node.js, function settings such as embedding adapters,
 * plugins, and an id generator included. File reads, file writes, file
 * syncs, and vector searches run on native threads, and a long import or
 * search yields to the app between steps.
 *
 * @param config - The engine settings. `durability` defaults to a
 * write-ahead log in the `narsil` directory of the app's private storage,
 * and `null` keeps every index in memory alone.
 * @returns The client, once the engine has started.
 * @throws A `NarsilError` with `NATIVE_DEPENDENCY_MISSING` when the app's
 * build lacks the native module, as in Expo Go.
 *
 * @public
 */
export async function createNarsil(config: PhoneNarsilConfig = {}): Promise<PhoneNarsil> {
  installEngineHost(await loadNativeObjects(), true)
  const narsil = await createEngine(withPhoneDurability(config))
  return phoneNarsil(narsil, installedHost())
}
