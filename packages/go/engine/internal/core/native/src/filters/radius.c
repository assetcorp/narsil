#include "radius.h"
#include "../math/fdlibm.h"
#include "geo.h"
#include "geo_constants.h"

#include <math.h>

filter_radius filter_radius_of(int precise, filter_point point, double distance) {
  filter_radius radius = {0};
  radius.point = point;
  radius.distance = distance;
  radius.precise = precise;
  radius.exact_within = -HUGE_VAL;
  radius.exact_beyond = HUGE_VAL;
  double angle = distance / FILTER_EARTH_RADIUS;
  if (precise) {
    if (distance < FILTER_GEODESIC_MIN_DISTANCE || angle > FILTER_GEODESIC_MAX_ANGLE) { return radius; }
    double nearest = (distance * (1 - FILTER_GEODESIC_BAND)) / FILTER_WGS84_LARGEST_CURVATURE / 2;
    double farthest = (distance * (1 + FILTER_GEODESIC_BAND)) / FILTER_WGS84_SMALLEST_CURVATURE / 2;
    radius.within = filter_sine_square_low(nearest * nearest) * (1 - FILTER_CHORD_SLACK);
    radius.beyond = filter_sine_square_high(farthest * farthest) * (1 + FILTER_CHORD_SLACK);
  } else {
    if (angle < FILTER_RADIUS_MIN_ANGLE || angle > FILTER_RADIUS_MAX_ANGLE) { return radius; }
    double sine = fdlibm_sin(angle / 2);
    double edge = sine * sine;
    radius.exact_within = edge * (1 - FILTER_RADIUS_EXACT_BAND);
    radius.exact_beyond = edge * (1 + FILTER_RADIUS_EXACT_BAND);
    double square = (angle / 2) * (angle / 2);
    if (square > FILTER_CHORD_MAX_SQUARE) { return radius; }
    radius.within = filter_sine_square_low(square) * (1 - FILTER_RADIUS_EXACT_BAND) * (1 - FILTER_CHORD_SLACK);
    radius.beyond = filter_sine_square_high(square) * (1 + FILTER_RADIUS_EXACT_BAND) * (1 + FILTER_CHORD_SLACK);
  }
  radius.bounded = filter_chord_origin_of(point);
  radius.use_bounds = 1;
  return radius;
}

int filter_radius_contains(filter_radius *radius, filter_point point) {
  filter_chord_bounds bounds;
  if (radius->use_bounds && filter_bound_chord(&radius->bounded, point, &bounds)) {
    if (bounds.upper < radius->within) { return 1; }
    if (bounds.lower > radius->beyond) { return 0; }
  }
  if (!radius->exact_ready) {
    radius->exact = filter_geo_origin_of(radius->point, radius->precise);
    radius->exact_ready = 1;
  }
  if (radius->precise) { return filter_vincenty(&radius->exact, point) <= radius->distance; }
  double chord = filter_half_chord(&radius->exact, point);
  if (chord < radius->exact_within) { return 1; }
  if (chord > radius->exact_beyond) { return 0; }
  return filter_chord_distance(chord) <= radius->distance;
}
