#include "scratch.h"

#include "../analysis/text.h"

#include <stddef.h>
#include <stdint.h>

void phrase_scratch_release(phrase_scratch *scratch) {
  narsil_code_points_release(&scratch->token_starts);
  narsil_code_points_release(&scratch->order);
  narsil_code_points_release(&scratch->spare);
  narsil_code_points_release(&scratch->leads);
  narsil_code_points_release(&scratch->phrase_order);
  narsil_code_points_release(&scratch->cursors);
  narsil_code_points_release(&scratch->ends);
  narsil_code_points_release(&scratch->position_rows);
  narsil_code_points_release(&scratch->matched);
  narsil_code_points_release(&scratch->next);
  narsil_code_points_release(&scratch->row_starts);
  narsil_code_points_release(&scratch->row_counts);
}

size_t phrase_scratch_bytes(const phrase_scratch *scratch) {
  return (scratch->token_starts.capacity + scratch->order.capacity + scratch->spare.capacity + scratch->leads.capacity +
          scratch->phrase_order.capacity + scratch->cursors.capacity + scratch->ends.capacity +
          scratch->position_rows.capacity + scratch->matched.capacity + scratch->next.capacity +
          scratch->row_starts.capacity + scratch->row_counts.capacity) *
         sizeof(uint32_t);
}
