#ifndef NARSIL_PATTERN_H
#define NARSIL_PATTERN_H

#include "narsil_core.h"
#include "narsil_stored_values.h"
#include "narsil_work.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  NARSIL_PATTERN_EQ,
  NARSIL_PATTERN_STARTS_WITH,
  NARSIL_PATTERN_ENDS_WITH,
  NARSIL_PATTERN_CONTAINS,
  NARSIL_PATTERN_WILDCARD,
  NARSIL_PATTERN_REGEX
};

typedef struct {
  const uint32_t *values;
  size_t count;
} narsil_pattern_list;

typedef struct {
  narsil_pattern_list documents;
  narsil_pattern_list runs;
  narsil_pattern_list offsets;
  narsil_pattern_list postings;
} narsil_pattern_index;

typedef struct {
  const uint16_t *text;
  size_t length;
  uint32_t operator_kind;
  uint32_t case_fold;
  uint32_t tolerance;
  uint32_t count_preparation;
  uint32_t matcher_bytes;
} narsil_pattern_test;

narsil_status narsil_pattern_match(narsil_workspace *workspace, const narsil_pattern_index *index,
                                   const narsil_stored_values *values, const narsil_pattern_test *test,
                                   const narsil_work_meter *meter, uint32_t *into, size_t into_words);

#ifdef __cplusplus
}
#endif

#endif
