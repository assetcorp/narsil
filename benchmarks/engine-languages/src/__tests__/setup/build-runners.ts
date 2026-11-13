import { prepareEngines } from '../../engines/catalog'
import { ensureOracle } from '../../oracle'
import { ENGINE_NAMES } from '../../runner-output'

export default async function buildRunnersBeforeAnyDriverStarts(): Promise<void> {
  await ensureOracle()
  await prepareEngines(ENGINE_NAMES)
}
