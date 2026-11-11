#include "scratch.h"

#include "../analysis/text.h"

#include <stddef.h>
#include <stdint.h>

void term_scratch_release(term_scratch *scratch) {
  narsil_code_points_release(&scratch->query);
  narsil_code_points_release(&scratch->candidate);
  narsil_code_points_release(&scratch->rows);
  narsil_code_points_release(&scratch->results);
  narsil_code_points_release(&scratch->spare);
  narsil_code_points_release(&scratch->seen);
}

size_t term_scratch_bytes(const term_scratch *scratch) {
  return (scratch->query.capacity + scratch->candidate.capacity + scratch->rows.capacity + scratch->results.capacity +
          scratch->spare.capacity + scratch->seen.capacity) *
         sizeof(uint32_t);
}
