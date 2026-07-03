import { useAppState, useBackend } from '@delali/narsil-example-shared'
import { BenchmarkView } from '@delali/narsil-example-shared/components/benchmark/BenchmarkView'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/benchmark')({ component: BenchmarkPage })

function BenchmarkPage() {
  const backend = useBackend()
  const state = useAppState()

  return <BenchmarkView backend={backend} state={state} />
}
