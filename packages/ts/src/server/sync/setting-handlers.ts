import type { Narsil } from '../../types/engine'
import type { SyncSetting } from '../../types/sync'
import { parseJson, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type { OkResponse } from '../types'

export function createSyncSettingHandlers(engine: Narsil) {
  async function getSync(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, await engine.getSync(ctx.params[0]))
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function updateSync(ctx: RouteContext): Promise<void> {
    const body = parseJson<SyncSetting>(ctx)
    if (body === undefined) return
    try {
      await engine.updateSync(ctx.params[0], body)
      respondJson(ctx, { ok: true } satisfies OkResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { getSync, updateSync }
}
