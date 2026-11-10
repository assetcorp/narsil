#include "text.h"

#include "../analysis/text.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  const uint16_t *units;
  size_t length;
  size_t at;
  const uint32_t *pending;
  uint32_t pending_at;
  uint32_t pending_count;
} fold_cursor;

size_t sort_text_length(const uint16_t *units, size_t length) {
  size_t position = 0;
  for (uint32_t count = 0; position < length && count < NARSIL_SORT_VALUE_MAX_CODE_POINTS; count++) {
    (void)narsil_decode_next(units, length, &position);
  }
  return position;
}

static const uint32_t *fold_mapping(uint32_t code_point) {
  size_t low = 0;
  size_t high = narsil_case_fold_count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    uint32_t source = narsil_case_folds[middle][0];
    if (source < code_point) {
      low = middle + 1;
    } else if (source > code_point) {
      high = middle;
    } else {
      return narsil_case_folds[middle];
    }
  }
  return NULL;
}

static uint32_t next_folded(fold_cursor *cursor) {
  if (cursor->pending_at < cursor->pending_count) { return cursor->pending[cursor->pending_at++]; }
  if (cursor->at == cursor->length) { return UINT32_MAX; }
  uint32_t point = narsil_decode_next(cursor->units, cursor->length, &cursor->at);
  if (point < NARSIL_ASCII_END) { return point >= 'A' && point <= 'Z' ? point + ('a' - 'A') : point; }
  const uint32_t *mapping = fold_mapping(point);
  if (mapping == NULL) { return point; }
  cursor->pending = mapping + 2;
  cursor->pending_count = mapping[1];
  cursor->pending_at = 1;
  return cursor->pending[0];
}

static int compare_folded(const uint16_t *left, size_t left_length, const uint16_t *right, size_t right_length) {
  fold_cursor lhs = {left, left_length, 0, NULL, 0, 0};
  fold_cursor rhs = {right, right_length, 0, NULL, 0, 0};
  for (;;) {
    uint32_t first = next_folded(&lhs);
    uint32_t second = next_folded(&rhs);
    if (first != second) {
      if (first == UINT32_MAX) { return -1; }
      if (second == UINT32_MAX) { return 1; }
      return first < second ? -1 : 1;
    }
    if (first == UINT32_MAX) { return 0; }
  }
}

int sort_text_compare(const uint16_t *left, size_t left_length, const uint16_t *right, size_t right_length) {
  int order = compare_folded(left, left_length, right, right_length);
  if (order != 0) { return order; }
  size_t first_at = 0;
  size_t second_at = 0;
  while (first_at < left_length && second_at < right_length) {
    uint32_t first = narsil_decode_next(left, left_length, &first_at);
    uint32_t second = narsil_decode_next(right, right_length, &second_at);
    if (first != second) { return first < second ? -1 : 1; }
  }
  if (first_at == left_length && second_at == right_length) { return 0; }
  return first_at == left_length ? -1 : 1;
}
