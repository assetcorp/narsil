#ifndef NARSIL_KEYWORD_ROWS_H
#define NARSIL_KEYWORD_ROWS_H

#include "scratch.h"

#include <stdint.h>

typedef struct {
  const uint32_t *doc_ids;
  const uint16_t *fields;
  const uint16_t *name_ranks;
  uint32_t field_count;
} keyword_row_keys;

const uint32_t *keyword_sort_rows(const keyword_row_keys *keys, keyword_scratch *scratch, uint32_t count);
int keyword_ranks_ascend(const keyword_row_keys *keys, uint32_t begin, uint32_t count);

#endif
