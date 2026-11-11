#include "geo.h"
#include "geo_constants.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static double eastward(double lon, int unwrap) { return unwrap && lon < 0 ? lon + FILTER_FULL_TURN : lon; }

static int compare_edges(const filter_geo_edge *first, const filter_geo_edge *second) {
  if (first->low != second->low) { return (first->low > second->low) - (first->low < second->low); }
  return (first->ordinal > second->ordinal) - (first->ordinal < second->ordinal);
}

static int edge_order(const void *left, const void *right) { return compare_edges(left, right); }

typedef struct {
  size_t start;
  size_t end;
  int children_done;
} edge_span;

static void fill_tree(filter_geo_edge *edges, size_t count) {
  edge_span stack[FILTER_EDGE_STACK] = {{0, count, 0}};
  size_t pending = 1;
  while (pending > 0) {
    edge_span span = stack[--pending];
    if (span.start >= span.end) { continue; }
    size_t middle = span.start + ((span.end - span.start) / 2);
    if (!span.children_done) {
      stack[pending++] = (edge_span){span.start, span.end, 1};
      stack[pending++] = (edge_span){middle + 1, span.end, 0};
      stack[pending++] = (edge_span){span.start, middle, 0};
      continue;
    }
    double high = edges[middle].high;
    if (span.start < middle) { high = fmax(high, edges[span.start + ((middle - span.start) / 2)].subtree_high); }
    if (middle + 1 < span.end) { high = fmax(high, edges[middle + 1 + ((span.end - middle - 1) / 2)].subtree_high); }
    edges[middle].subtree_high = high;
  }
}

size_t filter_polygon_prepare(const double *points, size_t count, filter_geo_scratch *scratch, filter_geo_box *boxes,
                              size_t *edge_count, int *unwrap) {
  double area = 0;
  double west = HUGE_VAL;
  double east = -HUGE_VAL;
  for (size_t at = 0, last = count - 1; at < count; last = at++) {
    area += (points[(last * 2) + 1] * points[at * 2]) - (points[(at * 2) + 1] * points[last * 2]);
    west = fmin(west, points[(at * 2) + 1]);
    east = fmax(east, points[(at * 2) + 1]);
  }
  *unwrap = east - west >= FILTER_LONGITUDE_LIMIT && area < 0;
  filter_geo_box box = {HUGE_VAL, -HUGE_VAL, HUGE_VAL, -HUGE_VAL};
  size_t used = 0;
  for (size_t at = 0, last = count - 1; at < count; last = at++) {
    double lat = points[at * 2];
    double lon = eastward(points[(at * 2) + 1], *unwrap);
    double last_lon = eastward(points[(last * 2) + 1], *unwrap);
    box.south = fmin(box.south, lat);
    box.north = fmax(box.north, lat);
    box.west = fmin(box.west, lon);
    box.east = fmax(box.east, lon);
    if (lon != last_lon) {
      scratch->edges[used++] = (filter_geo_edge){
          lat, lon, points[last * 2], last_lon, fmin(lon, last_lon), fmax(lon, last_lon), 0, (uint32_t)at};
    }
  }
  qsort(scratch->edges, used, sizeof *scratch->edges, edge_order);
  fill_tree(scratch->edges, used);
  *edge_count = used;
  if (box.west >= FILTER_LONGITUDE_LIMIT) {
    box.west -= FILTER_FULL_TURN;
    box.east -= FILTER_FULL_TURN;
  }
  return filter_longitude_boxes(box, boxes);
}

int filter_polygon_contains(const filter_geo_edge *edges, size_t count, filter_point point, int unwrap) {
  double lon = eastward(point.lon, unwrap);
  edge_span stack[FILTER_EDGE_STACK] = {{0, count, 0}};
  size_t pending = 1;
  int inside = 0;
  while (pending > 0) {
    edge_span span = stack[--pending];
    if (span.start >= span.end) { continue; }
    size_t middle = span.start + ((span.end - span.start) / 2);
    const filter_geo_edge *edge = &edges[middle];
    if (edge->subtree_high <= lon) { continue; }
    stack[pending++] = (edge_span){span.start, middle, 0};
    if (edge->low > lon) { continue; }
    if (lon < edge->high) {
      double intersection =
          edge->lat + (((edge->last_lat - edge->lat) / (edge->last_lon - edge->lon)) * (lon - edge->lon));
      if (point.lat < intersection) { inside = !inside; }
    }
    stack[pending++] = (edge_span){middle + 1, span.end, 0};
  }
  return inside;
}
