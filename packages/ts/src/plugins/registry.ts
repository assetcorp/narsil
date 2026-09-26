import { ErrorCodes, NarsilError } from '../errors'
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
  hasHooks(hookName: PluginHookName): boolean
}

interface BoundHook {
  plugin: string
  run: (ctx: never) => void | Promise<void>
}

const WRITE_REJECTING_HOOKS: ReadonlySet<PluginHookName> = new Set(['beforeInsert', 'beforeUpdate', 'beforeRemove'])

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).then === 'function'
}

function asWriteRejection(err: unknown, plugin: string, hookName: PluginHookName): unknown {
  if (err instanceof NarsilError) return err
  return new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, err instanceof Error ? err.message : String(err), {
    plugin,
    hook: hookName,
  })
}

function invoke(hook: BoundHook, hookName: PluginHookName, context: never): PromiseLike<unknown> | null {
  const rejectsWrites = WRITE_REJECTING_HOOKS.has(hookName)
  let result: unknown
  try {
    result = hook.run(context)
  } catch (err) {
    throw rejectsWrites ? asWriteRejection(err, hook.plugin, hookName) : err
  }
  if (!isThenable(result)) return null
  if (!rejectsWrites) return result
  return Promise.resolve(result).catch(err => {
    throw asWriteRejection(err, hook.plugin, hookName)
  })
}

async function continueAsync(
  pending: PromiseLike<unknown>,
  hooks: readonly BoundHook[],
  startIndex: number,
  hookName: PluginHookName,
  context: never,
): Promise<void> {
  await pending
  for (let i = startIndex; i < hooks.length; i++) {
    await invoke(hooks[i], hookName, context)
  }
}

export function createPluginRegistry(): PluginRegistry {
  const plugins: NarsilPlugin[] = []

  return {
    register(plugin: NarsilPlugin): void {
      plugins.push(plugin)
    },

    hasHooks(hookName: PluginHookName): boolean {
      return plugins.some(p => typeof p[hookName] === 'function')
    },

    runHook<T extends PluginHookName>(hookName: T, context: HookContext<T>): void | Promise<void> {
      const hooks: BoundHook[] = []

      for (const plugin of plugins) {
        const hook = plugin[hookName]
        if (typeof hook === 'function') {
          hooks.push({ plugin: plugin.name, run: (hook as (ctx: never) => void | Promise<void>).bind(plugin) })
        }
      }

      if (hooks.length === 0) return

      for (let i = 0; i < hooks.length; i++) {
        const pending = invoke(hooks[i], hookName, context as never)
        if (pending !== null) {
          return continueAsync(pending, hooks, i + 1, hookName, context as never)
        }
      }
    },
  }
}
