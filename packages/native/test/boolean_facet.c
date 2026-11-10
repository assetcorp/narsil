#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"

#include <stdint.h>

void boolean_facet_checks(void) {
  const uint32_t true_bits[] = {UINT32_C(0x80000003), 1};
  const uint32_t false_bits[] = {2};
  uint32_t matched[] = {3, 1};
  uint32_t counts[] = {UINT32_MAX, UINT32_MAX};
  narsil_boolean_index index = {true_bits, 2, false_bits, 1};
  check(narsil_boolean_facet(&index, matched, 2, counts, 2) == NARSIL_OK && counts[0] == 3 && counts[1] == 1,
        "boolean facets count overlapping values and unequal bitmap lengths");
  counts[0] = UINT32_MAX;
  counts[1] = UINT32_MAX;
  check(narsil_boolean_facet(&index, matched, 2, counts, 1) == NARSIL_NEEDS_ROOM && counts[0] == UINT32_MAX &&
            counts[1] == UINT32_MAX,
        "short boolean facet output remains unchanged");
  check(narsil_boolean_facet(&index, matched, 2, matched, 2) == NARSIL_INVALID_ARGUMENT && matched[0] == 3 &&
            matched[1] == 1,
        "boolean facet output cannot overwrite the matched bitmap");
  index.true_words = 0;
  check(narsil_boolean_facet(&index, matched, 2, counts, 2) == NARSIL_INVALID_ARGUMENT && counts[0] == UINT32_MAX,
        "boolean facets refuse missing bitmap words before writing");
}
