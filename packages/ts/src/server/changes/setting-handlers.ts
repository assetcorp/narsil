import type { ChangesSetting } from '../../types/changes'
import type { Narsil } from '../../types/engine'
import { parseJson, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { OkResponse } from '../types'

export function createChangesSettingHandlers(engine: Narsil) {
  async function getChanges(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, await engine.getChanges(ctx.params[0]))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function updateChanges(ctx: RouteContext): Promise<void> {
    const body = parseJson<ChangesSetting>(ctx)
    if (body === undefined) return
    try {
      await engine.updateChanges(ctx.params[0], body)
      respondJson(ctx, { ok: true } satisfies OkResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { getChanges, updateChanges }
}
