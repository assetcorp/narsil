#ifndef NARSIL_PATTERN_RUNS_H
#define NARSIL_PATTERN_RUNS_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_pattern.h"
#include "../analysis/text.h"
#include "../work/tally.h"
#include "constants.h"

#include <stddef.h>
#include <stdint.h>

typedef narsil_pattern_list pattern_list;
typedef narsil_pattern_index pattern_index;

typedef struct {
  uint32_t points[PATTERN_SHORTLIST_RUNS * PATTERN_RUN_POINTS];
  uint32_t count;
} pattern_runs;

pattern_list pattern_postings(const pattern_index *index, const uint32_t *run);
void pattern_keep_run(pattern_runs *runs, const uint32_t *points);
void pattern_spread_runs(pattern_runs *into, const pattern_list *factors, size_t count);
narsil_status pattern_shortlist(const pattern_list *lists, uint32_t count, narsil_code_points *candidates,
                                work_tally *tally);
void pattern_run_lists(const pattern_index *index, const pattern_runs *runs, pattern_list *lists);

#endif
