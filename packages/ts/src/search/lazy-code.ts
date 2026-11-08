import { ErrorCodes, NarsilError } from '../errors'

export function lazyCode<Module>(name: string, importModule: () => Promise<Module>) {
  let loaded: Module | null = null
  let loading: Promise<void> | null = null
  return {
    load(): Promise<void> | null {
      if (loaded !== null) return null
      loading ??= importModule().then(
        module => {
          loaded = module
        },
        (cause: unknown) => {
          loading = null
          throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The ${name} code could not load`, {
            cause: cause instanceof Error ? cause.message : String(cause),
          })
        },
      )
      return loading
    },
    get(): Module {
      if (loaded === null) throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The ${name} code has not loaded`)
      return loaded
    },
  }
}
