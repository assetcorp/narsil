#include "matching.h"

#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "dictionary.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static int compare(const narsil_term_lookup *request, uint32_t left, uint32_t right) {
  if (request->operation == NARSIL_LOOKUP_PREFIX) {
    uint32_t first = dictionary_frequency(request->dictionary, left);
    uint32_t second = dictionary_frequency(request->dictionary, right);
    if (first != second) { return first > second ? -1 : 1; }
  }
  int order = dictionary_compare(request->dictionary, left, right);
  return order == 0 ? (left > right) - (left < right) : order;
}

void term_sort(const narsil_term_lookup *request, term_scratch *scratch) {
  size_t count = scratch->results.length;
  uint32_t *source = scratch->results.values;
  uint32_t *target = scratch->spare.values;
  for (size_t width = 1; width < count;) {
    for (size_t start = 0; start < count;) {
      size_t middle = count - start < width ? count : start + width;
      size_t end = count - middle < width ? count : middle + width;
      size_t left = start;
      size_t right = middle;
      for (size_t at = start; at < end; at++) {
        target[at] = right == end || (left < middle && compare(request, source[left], source[right]) <= 0)
                         ? source[left++]
                         : source[right++];
      }
      start = end;
    }
    uint32_t *finished = source;
    source = target;
    target = finished;
    if (width > count / 2) { break; }
    width *= 2;
  }
  if (source != scratch->results.values && count > 0) {
    memcpy(scratch->results.values, source, count * sizeof *source);
  }
}
