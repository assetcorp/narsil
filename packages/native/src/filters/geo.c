#include "geo.h"
#include "../../include/narsil_filters.h"
#include "geo_constants.h"
#include "internal.h"
#include "radius.h"

#include <stddef.h>
#include <stdint.h>

static size_t first_code(const narsil_filter_region *region, uint64_t value) {
  const uint64_t *codes = region->data;
  size_t count = region->length;
  size_t low = 0;
  size_t high = count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (codes[middle] < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

void filter_geo_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operand,
                     uint32_t *into, filter_geo_scratch *scratch, uint32_t operator) {
  const double *values = program->numbers + operand;
  const uint64_t *codes = field->regions[1].data;
  const double *lat = field->regions[2].data;
  const double *lon = field->regions[3].data;
  const uint32_t *ordinals = field->regions[4].data;
  size_t count = field->regions[1].length;
  filter_geo_box boxes[2];
  filter_geo_range ranges[FILTER_GEO_RANGES];
  filter_radius circle = {0};
  size_t box_count;
  size_t edge_count = 0;
  int unwrap = 0;
  int radius = operator == NARSIL_FILTER_RADIUS;
  int precise = radius && values[3] == 1;
  if (radius) {
    box_count = filter_radius_boxes((filter_point){values[0], values[1]}, values[2], boxes);
    circle = filter_radius_of(precise, (filter_point){values[0], values[1]}, values[2]);
  } else {
    box_count = filter_polygon_prepare(values + 1, (size_t)values[0], scratch, boxes, &edge_count, &unwrap);
  }
  size_t range_count = filter_covering_ranges(boxes, box_count, ranges);
  for (size_t range = 0; range < range_count; range++) {
    size_t start = first_code(&field->regions[1], ranges[range].from);
    for (size_t at = start; at < count && codes[at] < ranges[range].to; at++) {
      int keep = radius ? filter_radius_contains(&circle, (filter_point){lat[at], lon[at]})
                        : filter_polygon_contains(scratch->edges, edge_count, (filter_point){lat[at], lon[at]}, unwrap);
      if (keep) { filter_set(into, program->live.count, ordinals[at]); }
    }
  }
}
