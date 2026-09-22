import { listModelsCached, makeHarness } from '@amagi/core'

export const listModelsFor = async (cfg: Parameters<typeof makeHarness>[0]) => {
  const harness = makeHarness(cfg)
  return listModelsCached(harness.kind, () => harness.listModels())
}
