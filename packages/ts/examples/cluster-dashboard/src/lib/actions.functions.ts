import { createServerFn } from '@tanstack/react-start'
import { NODES } from '../topology'
import type { ProvisionResult, ReadProbeResult } from './probe-types'
import { parseLinkInput, parseProbeInput, parseProvisionInput } from './validation'

export const setLinkFn = createServerFn({ method: 'POST' })
  .validator(parseLinkInput)
  .handler(async ({ data }) => {
    const [{ setProxyEnabled }, { nodeSpecOf }] = await Promise.all([import('./toxiproxy'), import('../topology')])
    const spec = nodeSpecOf(data.nodeId)
    const proxyName = data.kind === 'coordinator' ? spec.etcdProxyName : spec.replicationProxyName
    await setProxyEnabled(proxyName, data.enabled)
  })

export const healLinksFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { setProxyEnabled } = await import('./toxiproxy')
  for (const spec of NODES) {
    await setProxyEnabled(spec.etcdProxyName, true)
    await setProxyEnabled(spec.replicationProxyName, true)
  }
})

export const provisionIndexFn = createServerFn({ method: 'POST' })
  .validator(parseProvisionInput)
  .handler(async ({ data }): Promise<ProvisionResult> => {
    const { provisionIndex } = await import('./provision')
    return provisionIndex(data.nodeId)
  })

export const runReadProbeFn = createServerFn({ method: 'POST' })
  .validator(parseProbeInput)
  .handler(async ({ data }): Promise<ReadProbeResult> => {
    const { runReadProbe } = await import('./read-probe')
    return runReadProbe(data.nodeId, data.term)
  })
