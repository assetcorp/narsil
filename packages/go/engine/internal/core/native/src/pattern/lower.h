#ifndef NARSIL_PATTERN_LOWER_H
#define NARSIL_PATTERN_LOWER_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "ast.h"

#include <stdint.h>

typedef struct {
  const pattern_ast *source;
  pattern_ast *plan;
  narsil_code_points *mapping;
  narsil_code_points *folds;
  uint32_t case_fold;
} pattern_lowering;

uint32_t pattern_lower_list(pattern_lowering *lowering, const pattern_node *node);
uint32_t pattern_lower_set(pattern_lowering *lowering, uint32_t index);
narsil_status pattern_lower(pattern_lowering *lowering, const narsil_code_points *order);

#endif
