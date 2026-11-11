#ifndef NARSIL_PATTERN_INTERNAL_H
#define NARSIL_PATTERN_INTERNAL_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_pattern.h"
#include "../analysis/text.h"
#include "../regions.h"
#include "ast.h"
#include "cache.h"
#include "factors.h"
#include "literal.h"
#include "program.h"
#include "runs.h"
#include "simulation.h"
#include "typo.h"

#include <stddef.h>
#include <stdint.h>

enum { PATTERN_LITERAL_MATCHER, PATTERN_EXPRESSION_MATCHER, PATTERN_TYPO_MATCHER };
enum { PATTERN_WORD_BITS = 32 };

typedef struct {
  narsil_code_points raw;
  narsil_code_points folded;
  narsil_code_points order;
  narsil_code_points positions;
  narsil_code_points mapping;
  narsil_code_points folds;
  narsil_code_points candidates;
  narsil_code_points selected;
  pattern_ast parsed;
  pattern_ast lowered;
  pattern_factors factors;
  pattern_compiler compiler;
  pattern_program program;
  pattern_simulation simulation;
  pattern_cache cache;
  pattern_literal literal;
  pattern_typo typo;
  pattern_runs *branches;
  size_t branch_capacity;
  size_t branch_count;
  pattern_list *lists;
  size_t list_capacity;
  size_t list_count;
  uint32_t matcher;
  int64_t preparation_units;
} pattern_scratch;

typedef struct {
  const narsil_pattern_index *index;
  const narsil_stored_values *values;
  const narsil_pattern_test *test;
  const narsil_work_meter *meter;
  uint32_t *into;
  size_t into_words;
} pattern_request;

pattern_scratch *workspace_pattern_scratch(narsil_workspace *workspace);
narsil_status pattern_prepare(pattern_scratch *scratch, const narsil_pattern_test *test);
narsil_status pattern_prepare_expression(pattern_scratch *scratch, const narsil_pattern_test *test);
narsil_status pattern_reserve_branches(pattern_scratch *scratch, size_t count);
void pattern_scratch_release(pattern_scratch *scratch);
size_t pattern_scratch_bytes(const pattern_scratch *scratch);
narsil_status pattern_regions_valid(const pattern_request *request);
narsil_status pattern_prepare_lists(pattern_scratch *scratch, const pattern_request *request);
narsil_status pattern_evaluate(pattern_scratch *scratch, const pattern_request *request, work_tally *tally);
int pattern_match_document(uint32_t ordinal, const pattern_request *request, pattern_scratch *scratch,
                           work_tally *tally);

static inline int pattern_marked(const uint32_t *words, uint32_t ordinal) {
  return (words[ordinal / PATTERN_WORD_BITS] & (UINT32_C(1) << (ordinal % PATTERN_WORD_BITS))) != 0;
}

static inline void pattern_mark(uint32_t *words, uint32_t ordinal) {
  words[ordinal / PATTERN_WORD_BITS] |= UINT32_C(1) << (ordinal % PATTERN_WORD_BITS);
}

#endif
