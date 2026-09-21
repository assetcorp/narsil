export const OSQ_GRID: Readonly<Record<1 | 2 | 4 | 8, number>> = { 1: 0.798, 2: 1.493, 4: 2.514, 8: 3.922 }
export const OSQ_STEPS: Readonly<Record<1 | 2 | 4 | 8, number>> = { 1: 1, 2: 3, 4: 15, 8: 255 }
export const OSQ_QUERY_BITS: Readonly<Record<1 | 2 | 4 | 8, 4 | 8>> = { 1: 4, 2: 4, 4: 4, 8: 8 }
export const OSQ_LAMBDA = 0.1
export const OSQ_REFINE_ROUNDS = 5
export const OSQ_REFINE_TOLERANCE = 1e-8

export const DEFAULT_OVERSAMPLE_BY_BITS: Readonly<Record<1 | 2 | 4 | 8, number>> = { 1: 3, 2: 3, 4: 2, 8: 2 }
export const DEFAULT_OSQ4_NARROW_OVERSAMPLE = 5
export const OSQ4_NARROW_DIMENSION_LIMIT = 1024
export const MIN_OVERSAMPLE = 1
