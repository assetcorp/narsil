#ifndef NARSIL_TERM_SCRATCH_H
#define NARSIL_TERM_SCRATCH_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"

#include <stddef.h>

typedef struct {
  narsil_code_points query;
  narsil_code_points candidate;
  narsil_code_points rows;
  narsil_code_points results;
  narsil_code_points spare;
  narsil_code_points seen;
} term_scratch;

term_scratch *workspace_term_scratch(narsil_workspace *workspace);
void term_scratch_release(term_scratch *scratch);
size_t term_scratch_bytes(const term_scratch *scratch);

#endif
