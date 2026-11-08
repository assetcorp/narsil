#include "matching.h"

#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "dictionary.h"

#include <stddef.h>
#include <stdint.h>

static int64_t bound(const narsil_term_dictionary *dictionary, size_t prefix, const narsil_code_points *query,
                     int upper) {
  size_t low = 0;
  size_t high = dictionary_count(dictionary);
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    term_cursor cursor;
    if (!dictionary_cursor(dictionary, (uint32_t)middle, &cursor)) { return -1; }
    int valid = 0;
    int order = term_compare_query(cursor, query, prefix, &valid);
    if (!valid) { return -1; }
    if (order < 0 || (upper && order == 0)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return (int64_t)low;
}

void term_range(const narsil_term_lookup *request, const narsil_code_points *query, uint32_t *start, uint32_t *end) {
  *start = 0;
  *end = dictionary_count(request->dictionary);
  size_t prefix = query->length;
  if (request->operation == NARSIL_LOOKUP_TYPO && request->prefix_length < prefix) { prefix = request->prefix_length; }
  if (request->dictionary->growing != NULL || prefix == 0) { return; }
  int64_t first = bound(request->dictionary, prefix, query, 0);
  int64_t last = bound(request->dictionary, prefix, query, 1);
  if (first >= 0 && last >= first) {
    *start = (uint32_t)first;
    *end = (uint32_t)last;
  }
}
