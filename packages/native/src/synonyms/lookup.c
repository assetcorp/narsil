#include "internal.h"

#include "../../include/narsil_synonyms.h"
#include "../analysis/text.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>

static int compare(term_cursor stored, int *valid, term_cursor query) {
  *valid = 1;
  for (;;) {
    uint32_t first = 0;
    uint32_t second = 0;
    int left = term_next(&stored, &first);
    int right = term_next(&query, &second);
    if (left < 0) {
      *valid = 0;
      return 0;
    }
    if (left == 0 || right == 0) { return left - right; }
    if (second >= NARSIL_HIGH_SURROGATE_FIRST && second < NARSIL_SURROGATE_END) {
      second = NARSIL_REPLACEMENT_CHARACTER;
    }
    if (first != second) { return first < second ? -1 : 1; }
  }
}

int64_t synonym_rank(const narsil_synonym_request *request, uint32_t query) {
  const narsil_synonym_table *table = request->table;
  term_cursor word = {request->units, NULL, request->starts[query], request->starts[(size_t)query + 1]};
  size_t low = 0;
  size_t high = table->token_count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    term_cursor token = {NULL, table->tokens, table->offsets[middle], table->offsets[middle + 1]};
    term_cursor validation = token;
    uint32_t point = 0;
    int decoded = 0;
    while ((decoded = term_next(&validation, &point)) > 0) {}
    if (decoded < 0) { return -2; }
    int valid = 0;
    int order = compare(token, &valid, word);
    if (!valid) { return -2; }
    if (order == 0) { return (int64_t)middle; }
    if (order < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return -1;
}
