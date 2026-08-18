import { BenchmarkView } from '@delali/narsil-example-shared/components/benchmark/BenchmarkView'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/benchmark')({ component: BenchmarkView })
