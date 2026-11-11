#include "../../include/narsil_core.h"
#include "../../include/narsil_pattern.h"
#include "../regions.h"
#include "constants.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>

enum { FOLD_CASE = 1 };

static int valid_regions(const uint16_t *text, size_t length, uint32_t *points, size_t capacity, uint32_t *count) {
  memory_region input;
  memory_region folded;
  memory_region counted;
  if ((uintptr_t)text % _Alignof(uint16_t) != 0 || (uintptr_t)points % _Alignof(uint32_t) != 0 || count == NULL ||
      (uintptr_t)count % _Alignof(uint32_t) != 0 || length > UINT32_MAX / PATTERN_MAX_FOLD_LENGTH ||
      !region_of(text, length, sizeof *text, &input) || !region_of(points, capacity, sizeof *points, &folded) ||
      !region_of(count, 1, sizeof *count, &counted)) {
    return 0;
  }
  return !overlaps(folded, input) && !overlaps(counted, input) && !overlaps(counted, folded);
}

narsil_status narsil_case_fold(const uint16_t *text, size_t length, uint32_t *points, size_t capacity,
                               uint32_t *count) {
  if (!valid_regions(text, length, points, capacity, count)) { return NARSIL_INVALID_ARGUMENT; }
  pattern_text_cursor cursor = {text, length, 0, {0}, 0, 0, FOLD_CASE};
  uint32_t folded = 0;
  uint32_t point = 0;
  while (pattern_text_next(&cursor, &point)) {
    if (folded < capacity) { points[folded] = point; }
    folded += 1;
  }
  *count = folded;
  return folded > capacity ? NARSIL_NEEDS_ROOM : NARSIL_OK;
}
