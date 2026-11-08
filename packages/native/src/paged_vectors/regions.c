#include "internal.h"

#include "../../include/narsil_paged.h"
#include "../../include/narsil_paged_vectors.h"
#include "../paged/cache.h"
#include "../regions.h"
#include "../segments/regions.h"
#include "../work/tally.h"

#include <stddef.h>
#include <stdint.h>

int paged_vector_regions(segment_regions *regions, const narsil_page_cache *cache,
                         const narsil_paged_vector_field *field, const narsil_paged_vector_request *request,
                         const narsil_paged_vector_output *output, const uint32_t *count,
                         const narsil_page_fault *fault) {
  if (field == NULL || request == NULL || output == NULL || count == NULL || fault == NULL ||
      (uintptr_t)field % _Alignof(narsil_paged_vector_field) != 0 ||
      (uintptr_t)request % _Alignof(narsil_paged_vector_request) != 0 ||
      (uintptr_t)output % _Alignof(narsil_paged_vector_output) != 0 ||
      (uintptr_t)fault % _Alignof(narsil_page_fault) != 0 || !work_meter_valid(&request->meter)) {
    return 0;
  }
  if (!paged_cache_regions(regions, cache) ||
      !segment_region_write(regions, output->ordinals, output->ordinal_capacity, sizeof *output->ordinals) ||
      !segment_region_write(regions, output->scores, output->score_capacity, sizeof *output->scores) ||
      !segment_region_write(regions, count, 1, sizeof *count) ||
      !segment_region_write(regions, fault, sizeof *fault, 1) ||
      !segment_region_write(regions, request->meter.spent, 1, sizeof *request->meter.spent)) {
    return 0;
  }
  if (!segment_region_input(regions, field, 1, sizeof *field) ||
      !segment_region_input(regions, request, 1, sizeof *request) ||
      !segment_region_input(regions, output, 1, sizeof *output) ||
      !segment_region_input(regions, request->meter.stop, 1, sizeof *request->meter.stop) ||
      (cache != NULL && !segment_region_input(regions, cache, 1, sizeof *cache))) {
    return 0;
  }
  for (size_t at = 0; at < regions->write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions->writes[at], regions->writes[before])) { return 0; }
    }
  }
  return 1;
}
