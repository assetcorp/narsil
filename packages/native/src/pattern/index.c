#include "../../include/narsil_pattern.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_stored_values.h"
#include "../../include/narsil_work.h"
#include "../work/tally.h"
#include "internal.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static void release_inputs(pattern_scratch *scratch) {
  if (scratch->list_count > 0) { memset(scratch->lists, 0, scratch->list_count * sizeof *scratch->lists); }
  scratch->list_count = 0;
}

narsil_status narsil_pattern_match(narsil_workspace *workspace, const narsil_pattern_index *index,
                                   const narsil_stored_values *values, const narsil_pattern_test *test,
                                   const narsil_work_meter *meter, uint32_t *into, size_t into_words) {
  if (workspace == NULL) { return NARSIL_INVALID_ARGUMENT; }
  pattern_request request = {index, values, test, meter, into, into_words};
  narsil_status status = pattern_regions_valid(&request);
  if (status != NARSIL_OK) { return status; }
  pattern_scratch *scratch = workspace_pattern_scratch(workspace);
  status = pattern_prepare(scratch, test);
  if (status != NARSIL_OK) { return status; }
  status = pattern_prepare_lists(scratch, &request);
  if (status != NARSIL_OK) {
    release_inputs(scratch);
    return status;
  }
  work_tally tally;
  status = work_tally_begin(&tally, meter);
  if (status == NARSIL_OK) { status = work_tally_add(&tally, (uint64_t)scratch->preparation_units); }
  if (status == NARSIL_OK) { status = pattern_evaluate(scratch, &request, &tally); }
  narsil_status flushed = work_tally_flush(&tally);
  release_inputs(scratch);
  return status == NARSIL_OK ? flushed : status;
}
