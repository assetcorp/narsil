#ifndef NARSIL_SEGMENT_SCRATCH_H
#define NARSIL_SEGMENT_SCRATCH_H

#include "../../include/narsil_core.h"
#include "../field_merge/internal.h"
#include "../segment_merge/internal.h"
#include "frozen.h"
#include "postings.h"
#include "removal.h"
#include "runs.h"
#include "tokens.h"
#include "vacuum.h"

#include <stddef.h>

typedef struct {
  segment_token_plan tokens;
  segment_posting_plan postings;
  segment_run_plan runs;
  frozen_removal_plan frozen;
  segment_merge_scratch merge;
  field_merge_scratch fields;
  segment_vacuum vacuum;
  segment_removal_plan removal;
} segment_scratch;

segment_scratch *workspace_segment_scratch(narsil_workspace *workspace);
void segment_scratch_release(segment_scratch *scratch);
size_t segment_scratch_bytes(const segment_scratch *scratch);

#endif
