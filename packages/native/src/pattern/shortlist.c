#include "runs.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "../work/tally.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

void pattern_run_lists(const pattern_index *index, const pattern_runs *runs, pattern_list *lists) {
  for (uint32_t at = 0; at < runs->count; at++) {
    pattern_list list = pattern_postings(index, runs->points + ((size_t)at * PATTERN_RUN_POINTS));
    uint32_t position = at;
    while (position > 0 && list.count < lists[position - 1].count) {
      lists[position] = lists[position - 1];
      position--;
    }
    lists[position] = list;
  }
}

static narsil_status intersect(narsil_code_points *candidates, pattern_list list, work_tally *tally) {
  size_t kept = 0;
  size_t read = 0;
  if (list.count > 0 && work_tally_add(tally, 1) != NARSIL_OK) { return tally->status; }
  for (size_t at = 0; at < candidates->length; at++) {
    uint32_t candidate = candidates->values[at];
    while (read < list.count && list.values[read] < candidate) {
      read++;
      if (read < list.count && work_tally_add(tally, 1) != NARSIL_OK) { return tally->status; }
    }
    if (read == list.count) { break; }
    if (list.values[read] == candidate) { candidates->values[kept++] = candidate; }
  }
  candidates->length = kept;
  return NARSIL_OK;
}

narsil_status pattern_shortlist(const pattern_list *lists, uint32_t count, narsil_code_points *candidates,
                                work_tally *tally) {
  candidates->length = 0;
  if (count == 0 || count > PATTERN_SHORTLIST_RUNS || lists[0].count > candidates->capacity) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (uint32_t at = 0; at < count; at++) {
    if (work_tally_add(tally, 1) != NARSIL_OK) { return tally->status; }
  }
  if (work_tally_add(tally, lists[0].count) != NARSIL_OK) { return tally->status; }
  if (lists[0].count == 0) { return NARSIL_OK; }
  memcpy(candidates->values, lists[0].values, lists[0].count * sizeof *candidates->values);
  candidates->length = lists[0].count;
  for (uint32_t at = 1; at < count && candidates->length > 0; at++) {
    if (lists[at].count > (uint64_t)candidates->length * PATTERN_SHORTLIST_INTERSECT_RATIO) { break; }
    narsil_status status = intersect(candidates, lists[at], tally);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}
