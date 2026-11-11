#include "rows.h"

#include "scratch.h"

#include <stdint.h>

#define INSERTION_SORT_ROWS 16U
#define UNKNOWN_FIELD_RANK 0x10000U

typedef struct {
  const uint32_t *source;
  uint32_t *target;
} merge_pass;

static uint32_t rank_of(const keyword_row_keys *keys, uint32_t row) {
  uint16_t field = keys->fields[row];
  return field < keys->field_count ? keys->name_ranks[field] : UNKNOWN_FIELD_RANK;
}

static int row_before(const keyword_row_keys *keys, uint32_t lhs, uint32_t rhs) {
  uint32_t left_doc = keys->doc_ids[lhs];
  uint32_t right_doc = keys->doc_ids[rhs];
  if (left_doc != right_doc) { return left_doc < right_doc; }
  return rank_of(keys, lhs) < rank_of(keys, rhs);
}

static void insertion_sort(const keyword_row_keys *keys, uint32_t *order, uint32_t begin, uint32_t end) {
  for (uint32_t place = begin + 1; place < end; place++) {
    uint32_t row = order[place];
    uint32_t slot = place;
    while (slot > begin && row_before(keys, row, order[slot - 1])) {
      order[slot] = order[slot - 1];
      slot--;
    }
    order[slot] = row;
  }
}

static void merge_runs(const keyword_row_keys *keys, const merge_pass *merge, uint32_t begin, uint32_t middle,
                       uint32_t end) {
  uint32_t left = begin;
  uint32_t right = middle;
  uint32_t out = begin;
  while (left < middle && right < end) {
    if (row_before(keys, merge->source[right], merge->source[left])) {
      merge->target[out++] = merge->source[right++];
    } else {
      merge->target[out++] = merge->source[left++];
    }
  }
  while (left < middle) { merge->target[out++] = merge->source[left++]; }
  while (right < end) { merge->target[out++] = merge->source[right++]; }
}

static uint32_t smaller(uint64_t value, uint32_t limit) { return value < limit ? (uint32_t)value : limit; }

const uint32_t *keyword_sort_rows(const keyword_row_keys *keys, keyword_scratch *scratch, uint32_t count) {
  uint32_t *order = scratch->order;
  if (count <= INSERTION_SORT_ROWS) {
    insertion_sort(keys, order, 0, count);
    return order;
  }
  for (uint64_t begin = 0; begin < count; begin += INSERTION_SORT_ROWS) {
    insertion_sort(keys, order, (uint32_t)begin, smaller(begin + INSERTION_SORT_ROWS, count));
  }
  merge_pass merge = {order, scratch->order_spare};
  for (uint64_t width = INSERTION_SORT_ROWS; width < count; width *= 2) {
    for (uint64_t begin = 0; begin < count; begin += 2 * width) {
      merge_runs(keys, &merge, (uint32_t)begin, smaller(begin + width, count), smaller(begin + (2 * width), count));
    }
    uint32_t *written = merge.target;
    merge.target = merge.source == order ? order : scratch->order_spare;
    merge.source = written;
  }
  return merge.source;
}

int keyword_ranks_ascend(const keyword_row_keys *keys, uint32_t begin, uint32_t count) {
  for (uint32_t row = begin + 1; row < begin + count; row++) {
    if (rank_of(keys, row) < rank_of(keys, row - 1)) { return 0; }
  }
  return 1;
}
