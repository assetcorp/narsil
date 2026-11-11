#include "internal.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_frozen_segments.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

int segment_merge_text(const narsil_frozen_strings *strings, size_t offset, merge_text *text) {
  uint32_t start = strings->offsets[offset];
  uint32_t end = strings->offsets[offset + 1];
  if (start >= end || end > strings->text_bytes) { return 0; }
  term_cursor cursor = {NULL, strings->text, start, end};
  size_t units = 0;
  uint32_t point = 0;
  int next = 0;
  while ((next = term_next(&cursor, &point)) > 0) {
    units += point >= NARSIL_SUPPLEMENTARY_FIRST ? 2 : 1;
    if (units > NARSIL_MAX_ANALYSED_UNITS) { return 0; }
  }
  if (next < 0) { return 0; }
  *text = (merge_text){strings->text + start, end - start};
  return 1;
}

int segment_merge_compare_text(merge_text left, merge_text right) {
  size_t count = left.length < right.length ? left.length : right.length;
  int compared = count == 0 ? 0 : memcmp(left.bytes, right.bytes, count);
  if (compared != 0) { return compared < 0 ? -1 : 1; }
  return left.length < right.length ? -1 : left.length > right.length;
}
