export const NARROW_DIMENSION_LIMIT = 768
export const WIDE_DIMENSION_LIMIT = 1024

export const DEFAULT_EF_SEARCH_MARGIN_BY_BAND: Readonly<Record<'narrow' | 'middle' | 'wide', number>> = {
  narrow: 50,
  middle: 75,
  wide: 0,
}

export const DEFAULT_OSQ2_MIDDLE_RESCORE_DEPTH_WITHIN_WALK_PER_SQUARE_ROOT_OF_LIMIT = 18

export const DEFAULT_RESCORE_DEPTH_FLOOR_PER_LIMIT_BY_BITS: Readonly<Record<1 | 2 | 4 | 8, number>> = {
  1: 3,
  2: 3,
  4: 1,
  8: 1,
}

export const DEFAULT_RESCORE_DEPTH_BY_BITS: Readonly<
  Record<
    1 | 2 | 4 | 8,
    Readonly<Record<'narrow' | 'middle' | 'wide', { perLimit: number; perSquareRootOfLimit: number }>>
  >
> = {
  1: {
    narrow: { perLimit: 3.23, perSquareRootOfLimit: 55.9 },
    middle: { perLimit: 2.2, perSquareRootOfLimit: 27 },
    wide: { perLimit: 3, perSquareRootOfLimit: 0 },
  },
  2: {
    narrow: { perLimit: 2.6, perSquareRootOfLimit: 22.5 },
    middle: { perLimit: 1, perSquareRootOfLimit: 16 },
    wide: { perLimit: 3, perSquareRootOfLimit: 0 },
  },
  4: {
    narrow: { perLimit: 5, perSquareRootOfLimit: 0 },
    middle: { perLimit: 5, perSquareRootOfLimit: 0 },
    wide: { perLimit: 2, perSquareRootOfLimit: 0 },
  },
  8: {
    narrow: { perLimit: 2, perSquareRootOfLimit: 0 },
    middle: { perLimit: 2, perSquareRootOfLimit: 0 },
    wide: { perLimit: 2, perSquareRootOfLimit: 0 },
  },
}
