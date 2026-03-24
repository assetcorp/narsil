import { createFileRoute } from '@tanstack/react-router'
import { useBackend, useAppState } from '@delali/narsil-example-shared'
import { BenchmarkView } from '@delali/narsil-example-shared/components/benchmark/BenchmarkView'

export const Route = createFileRoute('/benchmark')({ component: BenchmarkPage })

function BenchmarkPage() {
  const backend = useBackend()
  const state = useAppState()

  return <BenchmarkView backend={backend} state={state} />
}
