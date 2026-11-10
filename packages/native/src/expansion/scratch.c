#include "internal.h"
#include "suggestions.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"
#include "../terms/scratch.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { FIRST_CANDIDATES = 32 };

void expansion_scratch_release(expansion_scratch *scratch) {
  free(scratch->candidates);
  free(scratch->surface_occurrences);
  narsil_code_points_release(&scratch->matches);
  narsil_text_release(&scratch->text);
  term_scratch_release(&scratch->typo);
  narsil_code_points_release(&scratch->written);
  narsil_code_points_release(&scratch->failure);
  narsil_code_points_release(&scratch->starts);
  suggestion_release(&scratch->suggestions);
  *scratch = (expansion_scratch){0};
}

size_t expansion_scratch_bytes(const expansion_scratch *scratch) {
  return (scratch->capacity * sizeof *scratch->candidates) +
         (scratch->surface_capacity * sizeof *scratch->surface_occurrences) +
         (scratch->matches.capacity * sizeof *scratch->matches.values) +
         (scratch->text.capacity * sizeof *scratch->text.units) + term_scratch_bytes(&scratch->typo) +
         (scratch->written.capacity * sizeof *scratch->written.values) +
         (scratch->failure.capacity * sizeof *scratch->failure.values) +
         (scratch->starts.capacity * sizeof *scratch->starts.values) + suggestion_bytes(&scratch->suggestions);
}

narsil_status expansion_add(expansion_scratch *scratch, const narsil_expansion_segment *source, uint32_t segment,
                            uint32_t token, size_t spelling_length) {
  narsil_term_dictionary dictionary;
  term_cursor cursor;
  if (!expansion_dictionary(source, &dictionary) || dictionary_frequency(&dictionary, token) == 0 ||
      !dictionary_cursor(&dictionary, token, &cursor)) {
    return NARSIL_OK;
  }
  size_t points = 0;
  if (!expansion_point_count(cursor, &points) || points == 0) { return NARSIL_OK; }
  if (scratch->count == scratch->capacity) {
    if (scratch->capacity > SIZE_MAX / 2) { return NARSIL_OUT_OF_MEMORY; }
    size_t capacity = scratch->capacity == 0 ? FIRST_CANDIDATES : scratch->capacity * 2;
    if (capacity > SIZE_MAX / sizeof *scratch->candidates) { return NARSIL_OUT_OF_MEMORY; }
    void *grown = realloc(scratch->candidates, capacity * sizeof *scratch->candidates);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->candidates = grown;
    scratch->capacity = capacity;
  }
  scratch->candidates[scratch->count++] = (expansion_candidate){cursor, segment, token, 0, spelling_length};
  return NARSIL_OK;
}
