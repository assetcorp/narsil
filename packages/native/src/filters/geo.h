#ifndef NARSIL_FILTER_GEO_H
#define NARSIL_FILTER_GEO_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  double lat;
  double lon;
} filter_point;

typedef struct {
  double lat;
  double lon;
  double cosine;
  double sine_reduced;
  double cosine_reduced;
} filter_geo_origin;

typedef struct {
  double south;
  double north;
  double west;
  double east;
} filter_geo_box;

typedef struct {
  uint64_t from;
  uint64_t to;
} filter_geo_range;

typedef struct {
  double lat;
  double lon;
  double last_lat;
  double last_lon;
  double low;
  double high;
  double subtree_high;
  uint32_t ordinal;
} filter_geo_edge;

typedef struct {
  filter_geo_edge *edges;
  size_t capacity;
} filter_geo_scratch;

filter_geo_origin filter_geo_origin_of(filter_point point, int precise);
double filter_haversine(const filter_geo_origin *origin, filter_point point);
double filter_vincenty(const filter_geo_origin *origin, filter_point point);
size_t filter_longitude_boxes(filter_geo_box box, filter_geo_box *boxes);
size_t filter_radius_boxes(filter_point point, double distance, filter_geo_box *boxes);
size_t filter_covering_ranges(const filter_geo_box *boxes, size_t count, filter_geo_range *ranges);
size_t filter_polygon_prepare(const double *points, size_t count, filter_geo_scratch *scratch, filter_geo_box *boxes,
                              size_t *edge_count, int *unwrap);
int filter_polygon_contains(const filter_geo_edge *edges, size_t count, filter_point point, int unwrap);

#endif
