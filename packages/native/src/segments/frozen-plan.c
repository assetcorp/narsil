#include "frozen.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "strings.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { FROZEN_CHANGE_CAPACITY = 32, FROZEN_CHANGE_GROWTH = 2 };

narsil_status frozen_removal_add(frozen_removal_plan *plan, uint32_t kind, uint32_t entry, double amount) {
  if (plan->count == plan->capacity) {
    size_t capacity = plan->capacity == 0 ? FROZEN_CHANGE_CAPACITY : plan->capacity;
    if (plan->capacity > 0) {
      if (capacity > SIZE_MAX / FROZEN_CHANGE_GROWTH) { return NARSIL_OUT_OF_MEMORY; }
      capacity *= FROZEN_CHANGE_GROWTH;
    }
    if (capacity > SIZE_MAX / sizeof *plan->changes) { return NARSIL_OUT_OF_MEMORY; }
    frozen_change *changes = realloc(plan->changes, capacity * sizeof *changes);
    if (changes == NULL) { return NARSIL_OUT_OF_MEMORY; }
    plan->changes = changes;
    plan->capacity = capacity;
  }
  plan->changes[plan->count++] = (frozen_change){kind, entry, amount};
  return NARSIL_OK;
}

void frozen_removal_release(frozen_removal_plan *plan) {
  free(plan->changes);
  segment_strings_release(&plan->surfaces);
  narsil_text_release(&plan->text);
  *plan = (frozen_removal_plan){0};
}

size_t frozen_removal_bytes(const frozen_removal_plan *plan) {
  return (plan->capacity * sizeof *plan->changes) + segment_strings_bytes(&plan->surfaces) +
         (plan->text.capacity * sizeof *plan->text.units);
}
