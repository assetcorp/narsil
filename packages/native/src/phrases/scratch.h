#ifndef NARSIL_PHRASE_SCRATCH_H
#define NARSIL_PHRASE_SCRATCH_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"

#include <stddef.h>

typedef struct {
  narsil_code_points token_starts;
  narsil_code_points order;
  narsil_code_points spare;
  narsil_code_points leads;
  narsil_code_points phrase_order;
  narsil_code_points cursors;
  narsil_code_points ends;
  narsil_code_points position_rows;
  narsil_code_points matched;
  narsil_code_points next;
  narsil_code_points row_starts;
  narsil_code_points row_counts;
} phrase_scratch;

phrase_scratch *workspace_phrase_scratch(narsil_workspace *workspace);
void phrase_scratch_release(phrase_scratch *scratch);
size_t phrase_scratch_bytes(const phrase_scratch *scratch);

#endif
