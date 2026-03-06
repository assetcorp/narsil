import type { NarsilPlugin } from '../types/plugins'

export type PluginHookName = Exclude<keyof NarsilPlugin, 'name'>

type HookContext<T extends PluginHookName> = NarsilPlugin[T] extends
  | ((ctx: infer C) => void | Promise<void>)
  | undefined
  ? C
  : never

export interface PluginRegistry {
  register(plugin: NarsilPlugin): void
  runHook<T extends PluginHookName>(hookName: T, context: HookContext<T>): void | Promise<void>
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).then === 'function'
}

async function continueAsync(
  pending: PromiseLike<unknown>,
  hooks: Array<(ctx: never) => void | Promise<void>>,
  startIndex: number,
  context: never,
): Promise<void> {
  await pending
  for (let i = startIndex; i < hooks.length; i++) {
    await hooks[i](context)
  }
}

export function createPluginRegistry(): PluginRegistry {
  const plugins: NarsilPlugin[] = []

  return {
    register(plugin: NarsilPlugin): void {
      plugins.push(plugin)
    },

    runHook<T extends PluginHookName>(hookName: T, context: HookContext<T>): void | Promise<void> {
      const hooks: Array<(ctx: never) => void | Promise<void>> = []

      for (const plugin of plugins) {
        const hook = plugin[hookName]
        if (typeof hook === 'function') {
          hooks.push((hook as (ctx: never) => void | Promise<void>).bind(plugin))
        }
      }

      if (hooks.length === 0) return

      for (let i = 0; i < hooks.length; i++) {
        const result = hooks[i](context as never)
        if (isThenable(result)) {
          return continueAsync(result, hooks, i + 1, context as never)
        }
      }
    },
  }
}
