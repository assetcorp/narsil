#ifndef NARSIL_FILTER_RADIUS_H
#define NARSIL_FILTER_RADIUS_H

#include "geo.h"

typedef struct {
  filter_point point;
  double phi;
  double cosine_low;
  double cosine_high;
  double sine_low;
  double sine_high;
} filter_chord_origin;

typedef struct {
  double lower;
  double upper;
} filter_chord_bounds;

typedef struct {
  filter_point point;
  double distance;
  double within;
  double beyond;
  double exact_within;
  double exact_beyond;
  filter_chord_origin bounded;
  filter_geo_origin exact;
  int precise;
  int use_bounds;
  int exact_ready;
} filter_radius;

double filter_sine_square_low(double square);
double filter_sine_square_high(double square);
filter_chord_origin filter_chord_origin_of(filter_point point);
int filter_bound_chord(const filter_chord_origin *origin, filter_point point, filter_chord_bounds *bounds);
filter_radius filter_radius_of(int precise, filter_point point, double distance);
int filter_radius_contains(filter_radius *radius, filter_point point);
double filter_half_chord(const filter_geo_origin *origin, filter_point point);
double filter_chord_distance(double chord);

#endif
