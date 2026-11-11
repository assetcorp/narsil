#include "scratch.h"

#include "../analysis/split.h"
#include "../analysis/text.h"
#include "../terms/scratch.h"

#include <stddef.h>
#include <stdlib.h>

void highlight_release(highlight_scratch *scratch) {
  free(scratch->origins);
  narsil_text_release(&scratch->width);
  narsil_text_release(&scratch->composed);
  narsil_code_points_release(&scratch->decomposed);
  narsil_spans_release(&scratch->offsets);
  narsil_spans_release(&scratch->marked);
  narsil_text_release(&scratch->snippet);
  term_scratch_release(&scratch->distance);
  *scratch = (highlight_scratch){0};
}

size_t highlight_bytes(const highlight_scratch *scratch) {
  return (scratch->origin_capacity * sizeof *scratch->origins) +
         (scratch->width.capacity * sizeof *scratch->width.units) +
         (scratch->composed.capacity * sizeof *scratch->composed.units) +
         (scratch->decomposed.capacity * sizeof *scratch->decomposed.values) +
         (scratch->offsets.capacity * sizeof *scratch->offsets.spans) +
         (scratch->marked.capacity * sizeof *scratch->marked.spans) +
         (scratch->snippet.capacity * sizeof *scratch->snippet.units) + term_scratch_bytes(&scratch->distance);
}
