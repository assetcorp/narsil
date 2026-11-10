#include "internal.h"

#include "../analysis/text.h"

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

void pattern_scratch_release(pattern_scratch *scratch) {
  narsil_code_points *regions[] = {&scratch->raw,
                                   &scratch->folded,
                                   &scratch->order,
                                   &scratch->positions,
                                   &scratch->mapping,
                                   &scratch->folds,
                                   &scratch->candidates,
                                   &scratch->selected,
                                   &scratch->factors.points,
                                   &scratch->factors.ends,
                                   &scratch->factors.stack,
                                   &scratch->compiler.previous,
                                   &scratch->compiler.order,
                                   &scratch->program.predicates.ranges,
                                   &scratch->program.predicates.temporary,
                                   &scratch->program.class_edges,
                                   &scratch->simulation.marks,
                                   &scratch->simulation.stack,
                                   &scratch->simulation.candidates,
                                   &scratch->simulation.after,
                                   &scratch->simulation.starts,
                                   &scratch->typo.raw,
                                   &scratch->typo.folded,
                                   &scratch->typo.value};
  for (size_t at = 0; at < sizeof regions / sizeof regions[0]; at++) { narsil_code_points_release(regions[at]); }
  free(scratch->parsed.nodes);
  free(scratch->lowered.nodes);
  free(scratch->factors.lists);
  free(scratch->compiler.frames);
  free(scratch->compiler.prepared);
  free(scratch->program.states);
  free(scratch->cache.words);
  free(scratch->literal.allocation);
  free(scratch->typo.rows);
  free(scratch->branches);
  free(scratch->lists);
  memset(scratch, 0, sizeof *scratch);
}

size_t pattern_scratch_bytes(const pattern_scratch *scratch) {
  const narsil_code_points *regions[] = {&scratch->raw,
                                         &scratch->folded,
                                         &scratch->order,
                                         &scratch->positions,
                                         &scratch->mapping,
                                         &scratch->folds,
                                         &scratch->candidates,
                                         &scratch->selected,
                                         &scratch->factors.points,
                                         &scratch->factors.ends,
                                         &scratch->factors.stack,
                                         &scratch->compiler.previous,
                                         &scratch->compiler.order,
                                         &scratch->program.predicates.ranges,
                                         &scratch->program.predicates.temporary,
                                         &scratch->program.class_edges,
                                         &scratch->simulation.marks,
                                         &scratch->simulation.stack,
                                         &scratch->simulation.candidates,
                                         &scratch->simulation.after,
                                         &scratch->simulation.starts,
                                         &scratch->typo.raw,
                                         &scratch->typo.folded,
                                         &scratch->typo.value};
  size_t bytes = 0;
  for (size_t at = 0; at < sizeof regions / sizeof regions[0]; at++) {
    bytes += regions[at]->capacity * sizeof *regions[at]->values;
  }
  return bytes + (scratch->parsed.capacity * sizeof *scratch->parsed.nodes) +
         (scratch->lowered.capacity * sizeof *scratch->lowered.nodes) +
         (scratch->factors.list_capacity * sizeof *scratch->factors.lists) +
         (scratch->compiler.capacity * (sizeof *scratch->compiler.frames + sizeof *scratch->compiler.prepared)) +
         (scratch->program.capacity * sizeof *scratch->program.states) +
         (scratch->cache.capacity * sizeof *scratch->cache.words) +
         (scratch->literal.capacity * 2 * sizeof *scratch->literal.allocation) +
         (scratch->typo.row_capacity * 2 * sizeof *scratch->typo.rows) +
         (scratch->branch_capacity * sizeof *scratch->branches) + (scratch->list_capacity * sizeof *scratch->lists);
}
