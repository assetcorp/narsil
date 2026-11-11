#include "text.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "../sort/text.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>

uint32_t pattern_fold_point(uint32_t point, uint32_t *into) {
  if (point < NARSIL_ASCII_END) {
    into[0] = point >= 'A' && point <= 'Z' ? point + ('a' - 'A') : point;
    return 1;
  }
  size_t low = 0;
  size_t high = narsil_case_fold_count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    const uint32_t *mapping = narsil_case_folds[middle];
    if (mapping[0] < point) {
      low = middle + 1;
    } else if (mapping[0] > point) {
      high = middle;
    } else {
      if (mapping[1] == 0 || mapping[1] > PATTERN_MAX_FOLD_LENGTH) { break; }
      for (uint32_t i = 0; i < mapping[1]; i++) { into[i] = mapping[i + 2]; }
      return mapping[1];
    }
  }
  into[0] = point;
  return 1;
}

int pattern_text_next(pattern_text_cursor *cursor, uint32_t *point) {
  if (cursor->folded_at < cursor->folded_count && cursor->folded_at < PATTERN_MAX_FOLD_LENGTH) {
    *point = cursor->folded[cursor->folded_at++];
    return 1;
  }
  if (cursor->at >= cursor->length) { return 0; }
  *point = narsil_decode_next(cursor->units, cursor->length, &cursor->at);
  if (cursor->case_fold == 0) { return 1; }
  cursor->folded_count = pattern_fold_point(*point, cursor->folded);
  cursor->folded_at = 1;
  *point = cursor->folded[0];
  return 1;
}

narsil_status pattern_text_points(narsil_code_points *out, const uint16_t *units, size_t length, uint32_t case_fold) {
  pattern_text_cursor cursor = {units, length, 0, {0}, 0, 0, case_fold};
  out->length = 0;
  uint32_t point = 0;
  while (pattern_text_next(&cursor, &point)) {
    int status = narsil_code_points_push(out, point);
    if (status != NARSIL_OK) { return (narsil_status)status; }
  }
  return NARSIL_OK;
}
