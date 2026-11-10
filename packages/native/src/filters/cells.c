#include "../math/fdlibm.h"
#include "geo.h"
#include "geo_constants.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

size_t filter_longitude_boxes(filter_geo_box box, filter_geo_box *boxes) {
  if (box.east - box.west >= FILTER_FULL_TURN) {
    box.west = -FILTER_LONGITUDE_LIMIT;
    box.east = FILTER_LONGITUDE_LIMIT;
  }
  if (box.west < -FILTER_LONGITUDE_LIMIT) {
    boxes[0] = (filter_geo_box){box.south, box.north, box.west + FILTER_FULL_TURN, FILTER_LONGITUDE_LIMIT};
    boxes[1] = (filter_geo_box){box.south, box.north, -FILTER_LONGITUDE_LIMIT, box.east};
    return 2;
  }
  if (box.east > FILTER_LONGITUDE_LIMIT) {
    boxes[0] = (filter_geo_box){box.south, box.north, box.west, FILTER_LONGITUDE_LIMIT};
    boxes[1] = (filter_geo_box){box.south, box.north, -FILTER_LONGITUDE_LIMIT, box.east - FILTER_FULL_TURN};
    return 2;
  }
  boxes[0] = box;
  return 1;
}

size_t filter_radius_boxes(filter_point point, double distance, filter_geo_box *boxes) {
  double lat = point.lat;
  double lon = point.lon;
  double angle = ((distance / FILTER_EARTH_RADIUS) * FILTER_RADIUS_BOX_RATIO) + FILTER_RADIUS_BOX_MARGIN;
  double degrees = angle / FILTER_DEGREES_TO_RADIANS;
  double south = lat - degrees;
  double north = lat + degrees;
  if (angle >= FILTER_PI || south <= -FILTER_LATITUDE_LIMIT || north >= FILTER_LATITUDE_LIMIT) {
    boxes[0] = (filter_geo_box){fmax(south, -FILTER_LATITUDE_LIMIT), fmin(north, FILTER_LATITUDE_LIMIT),
                                -FILTER_LONGITUDE_LIMIT, FILTER_LONGITUDE_LIMIT};
    return 1;
  }
  double spread_sine = fmin(1, fdlibm_sin(angle) / fdlibm_cos(lat * FILTER_DEGREES_TO_RADIANS));
  double spread = fdlibm_asin(spread_sine) / FILTER_DEGREES_TO_RADIANS;
  return filter_longitude_boxes((filter_geo_box){south, north, lon - spread, lon + spread}, boxes);
}

static uint32_t cell(double value, double low, double span) {
  double placed = floor(((value - low) / span) * (double)(UINT32_C(1) << FILTER_CELL_BITS));
  if (!(placed > 0)) { return 0; }
  if (placed >= (double)(UINT32_C(1) << FILTER_CELL_BITS)) { return (UINT32_C(1) << FILTER_CELL_BITS) - 1; }
  return (uint32_t)placed;
}

static uint64_t interleave(uint32_t row, uint32_t column, unsigned int bits) {
  uint64_t code = 0;
  while (bits > 0) {
    bits--;
    code = (code * 4) + (((uint64_t)(row >> bits) & 1) * 2) + ((column >> bits) & 1);
  }
  return code;
}

static size_t box_ranges(const filter_geo_box *box, filter_geo_range *ranges) {
  uint32_t south = cell(box->south, -FILTER_LATITUDE_LIMIT, FILTER_LONGITUDE_LIMIT);
  uint32_t north = cell(box->north, -FILTER_LATITUDE_LIMIT, FILTER_LONGITUDE_LIMIT);
  uint32_t west = cell(box->west, -FILTER_LONGITUDE_LIMIT, FILTER_FULL_TURN);
  uint32_t east = cell(box->east, -FILTER_LONGITUDE_LIMIT, FILTER_FULL_TURN);
  unsigned int level = FILTER_CELL_BITS;
  while (level > 0) {
    unsigned int shift = FILTER_CELL_BITS - level;
    uint64_t rows = (north >> shift) - (south >> shift) + UINT64_C(1);
    uint64_t columns = (east >> shift) - (west >> shift) + UINT64_C(1);
    if (rows * columns <= FILTER_COVERING_CELLS) { break; }
    level--;
  }
  unsigned int shift = FILTER_CELL_BITS - level;
  uint64_t codes_per_cell = UINT64_C(1) << (2 * shift);
  size_t count = 0;
  for (uint32_t row = south >> shift; row <= (north >> shift); row++) {
    for (uint32_t column = west >> shift; column <= (east >> shift); column++) {
      uint64_t from = interleave(row, column, level) * codes_per_cell;
      ranges[count++] = (filter_geo_range){from, from + codes_per_cell};
    }
  }
  return count;
}

static int compare_ranges(const filter_geo_range *left, const filter_geo_range *right) {
  return (left->from > right->from) - (left->from < right->from);
}

static int range_order(const void *left, const void *right) { return compare_ranges(left, right); }

size_t filter_covering_ranges(const filter_geo_box *boxes, size_t count, filter_geo_range *ranges) {
  size_t used = 0;
  for (size_t at = 0; at < count; at++) { used += box_ranges(&boxes[at], ranges + used); }
  qsort(ranges, used, sizeof *ranges, range_order);
  size_t merged = 0;
  for (size_t at = 0; at < used; at++) {
    if (merged > 0 && ranges[at].from <= ranges[merged - 1].to) {
      if (ranges[at].to > ranges[merged - 1].to) { ranges[merged - 1].to = ranges[at].to; }
    } else {
      ranges[merged++] = ranges[at];
    }
  }
  return merged;
}
