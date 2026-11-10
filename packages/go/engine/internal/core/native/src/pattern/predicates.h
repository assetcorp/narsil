#ifndef NARSIL_PATTERN_PREDICATES_H
#define NARSIL_PATTERN_PREDICATES_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "ast.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t start;
  uint32_t count;
  uint32_t negated;
} pattern_predicate;

typedef struct {
  narsil_code_points ranges;
  narsil_code_points temporary;
} pattern_predicates;

narsil_status pattern_predicate_build(const pattern_ast *plan, uint32_t node, pattern_predicates *scratch,
                                      pattern_predicate *predicate, uint32_t case_fold);
int pattern_ranges_contain(uint32_t point, const uint32_t *ranges, size_t count);

#endif
