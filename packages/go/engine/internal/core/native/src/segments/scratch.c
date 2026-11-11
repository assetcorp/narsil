#include "scratch.h"

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

void segment_scratch_release(segment_scratch *scratch) {
  segment_tokens_release(&scratch->tokens);
  segment_postings_release(&scratch->postings);
  segment_runs_release(&scratch->runs);
  frozen_removal_release(&scratch->frozen);
  segment_merge_release(&scratch->merge);
  field_merge_release(&scratch->fields);
  segment_vacuum_release(&scratch->vacuum);
  segment_removal_release(&scratch->removal);
}

size_t segment_scratch_bytes(const segment_scratch *scratch) {
  return segment_tokens_bytes(&scratch->tokens) + segment_postings_bytes(&scratch->postings) +
         segment_runs_bytes(&scratch->runs) + frozen_removal_bytes(&scratch->frozen) +
         segment_merge_bytes(&scratch->merge) + field_merge_bytes(&scratch->fields) +
         segment_vacuum_bytes(&scratch->vacuum) + segment_removal_bytes(&scratch->removal);
}

segment_merge_scratch *workspace_segment_merge_scratch(narsil_workspace *workspace) {
  return &workspace_segment_scratch(workspace)->merge;
}

field_merge_scratch *workspace_field_merge_scratch(narsil_workspace *workspace) {
  return &workspace_segment_scratch(workspace)->fields;
}
