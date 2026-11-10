#ifndef NARSIL_PATTERN_FACTORS_H
#define NARSIL_PATTERN_FACTORS_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "ast.h"
#include "runs.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  narsil_code_points points;
  narsil_code_points ends;
  narsil_code_points stack;
  pattern_list *lists;
  size_t list_capacity;
  size_t start;
} pattern_factors;

narsil_status pattern_factor_runs(const pattern_ast *tree, uint32_t root, pattern_factors *scratch, pattern_runs *runs);

#endif
