#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"

#include <stdint.h>

void enum_facet_checks(narsil_workspace *workspace) {
  enum { POSTINGS = 7, VALUES = 3, SPARSE_ORDINAL = 33, FIRST_MATCHES = 5, LAST_START = 6 };
  uint32_t offsets[] = {0, 3, LAST_START, POSTINGS};
  uint32_t postings[] = {0, SPARSE_ORDINAL, 0, 2, 2, SPARSE_ORDINAL, UINT32_MAX};
  uint32_t matched[] = {FIRST_MATCHES, 2};
  uint32_t counts[] = {UINT32_MAX, UINT32_MAX, UINT32_MAX};
  check(narsil_enum_facet(workspace, offsets, VALUES + 1, postings, POSTINGS, matched, 2, counts, VALUES) ==
                NARSIL_OK &&
            counts[0] == 2 && counts[1] == 2 && counts[2] == 0,
        "enum facets count repeated sparse ordinals once and skip ordinals outside the bitmap");
  counts[0] = UINT32_MAX;
  counts[1] = UINT32_MAX;
  counts[2] = UINT32_MAX;
  check(narsil_enum_facet(workspace, offsets, VALUES + 1, postings, POSTINGS, matched, 2, counts, VALUES - 1) ==
                NARSIL_NEEDS_ROOM &&
            counts[0] == UINT32_MAX && counts[1] == UINT32_MAX && counts[2] == UINT32_MAX,
        "short enum output remains unchanged");
  check(narsil_enum_facet(workspace, offsets, VALUES + 1, postings, POSTINGS, matched, 2, offsets, VALUES) ==
                NARSIL_INVALID_ARGUMENT &&
            offsets[0] == 0,
        "enum output cannot overwrite offsets");
  offsets[2] = UINT32_MAX;
  check(narsil_enum_facet(workspace, offsets, VALUES + 1, postings, POSTINGS, matched, 2, counts, VALUES) ==
                NARSIL_OK &&
            counts[0] == 2 && counts[1] == 0 && counts[2] == 0,
        "enum facets skip corrupt embedded posting spans");
  check(narsil_enum_facet(workspace, NULL, 0, NULL, 0, matched, 2, NULL, 0) == NARSIL_INVALID_ARGUMENT,
        "an empty enum dictionary requires a terminal offset");
  check(narsil_enum_facet(workspace, offsets, 1, NULL, 0, NULL, 0, NULL, 0) == NARSIL_INVALID_ARGUMENT,
        "an empty enum dictionary requires a matched bitmap word");
}
