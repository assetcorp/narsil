#include "../math/fdlibm.h"
#include "geo.h"
#include "geo_constants.h"
#include "radius.h"

#include <math.h>

static const double CORRECTION_DIVISOR = 16;
static const double POLYNOMIAL_A_DIVISOR = 16384;
static const double POLYNOMIAL_A_FIRST = 4096;
static const double POLYNOMIAL_A_SECOND = -768;
static const double POLYNOMIAL_A_THIRD = 320;
static const double POLYNOMIAL_A_FOURTH = 175;
static const double POLYNOMIAL_B_DIVISOR = 1024;
static const double POLYNOMIAL_B_FIRST = 256;
static const double POLYNOMIAL_B_SECOND = -128;
static const double POLYNOMIAL_B_THIRD = 74;
static const double POLYNOMIAL_B_FOURTH = 47;
static const double DELTA_DIVISOR = 6;

filter_geo_origin filter_geo_origin_of(filter_point point, int precise) {
  double lat = point.lat;
  double lon = point.lon;
  filter_geo_origin origin = {lat, lon, fdlibm_cos(lat * FILTER_DEGREES_TO_RADIANS), 0, 0};
  if (precise) {
    double reduced = fdlibm_atan((1 - FILTER_WGS84_F) * fdlibm_tan(lat * FILTER_DEGREES_TO_RADIANS));
    origin.sine_reduced = fdlibm_sin(reduced);
    origin.cosine_reduced = fdlibm_cos(reduced);
  }
  return origin;
}

double filter_half_chord(const filter_geo_origin *origin, filter_point point) {
  double lat = point.lat;
  double lon = point.lon;
  double phi = lat * FILTER_DEGREES_TO_RADIANS;
  double delta_phi = (lat - origin->lat) * FILTER_DEGREES_TO_RADIANS;
  double delta_lambda = (lon - origin->lon) * FILTER_DEGREES_TO_RADIANS;
  double half_phi = fdlibm_sin(delta_phi / 2);
  double half_lambda = fdlibm_sin(delta_lambda / 2);
  return (half_phi * half_phi) + (origin->cosine * fdlibm_cos(phi) * half_lambda * half_lambda);
}

double filter_chord_distance(double chord) {
  double angle = 2 * fdlibm_atan2(sqrt(chord), sqrt(1 - chord));
  return FILTER_EARTH_RADIUS * angle;
}

double filter_haversine(const filter_geo_origin *origin, filter_point point) {
  return filter_chord_distance(filter_half_chord(origin, point));
}

double filter_vincenty(const filter_geo_origin *origin, filter_point point) {
  double lat = point.lat;
  double lon = point.lon;
  double sin_u1 = origin->sine_reduced;
  double cos_u1 = origin->cosine_reduced;
  double phi2 = lat * FILTER_DEGREES_TO_RADIANS;
  double longitude = (lon - origin->lon) * FILTER_DEGREES_TO_RADIANS;
  double reduced = fdlibm_atan((1 - FILTER_WGS84_F) * fdlibm_tan(phi2));
  double sin_u2 = fdlibm_sin(reduced);
  double cos_u2 = fdlibm_cos(reduced);
  double lambda = longitude;
  double previous;
  double sin_sigma = 0;
  double cos_sigma = 0;
  double sigma = 0;
  double sin_alpha = 0;
  double cos2_alpha = 0;
  double cos2_sigma_m = 0;
  int iterations = FILTER_VINCENTY_ITERATIONS;
  do {
    double sin_lambda = fdlibm_sin(lambda);
    double cos_lambda = fdlibm_cos(lambda);
    double term1 = cos_u2 * sin_lambda;
    double term2 = (cos_u1 * sin_u2) - (sin_u1 * cos_u2 * cos_lambda);
    sin_sigma = sqrt((term1 * term1) + (term2 * term2));
    if (sin_sigma == 0) { return 0; }
    cos_sigma = (sin_u1 * sin_u2) + (cos_u1 * cos_u2 * cos_lambda);
    sigma = fdlibm_atan2(sin_sigma, cos_sigma);
    sin_alpha = (cos_u1 * cos_u2 * sin_lambda) / sin_sigma;
    cos2_alpha = 1 - (sin_alpha * sin_alpha);
    cos2_sigma_m = cos2_alpha == 0 ? 0 : cos_sigma - ((2 * sin_u1 * sin_u2) / cos2_alpha);
    double correction =
        (FILTER_WGS84_F / CORRECTION_DIVISOR) * cos2_alpha * (4 + (FILTER_WGS84_F * (4 - (3 * cos2_alpha))));
    previous = lambda;
    double inner = cos2_sigma_m + (correction * cos_sigma * (-1 + (2 * cos2_sigma_m * cos2_sigma_m)));
    lambda = longitude + ((1 - correction) * FILTER_WGS84_F * sin_alpha * (sigma + (correction * sin_sigma * inner)));
  } while (fabs(lambda - previous) > FILTER_VINCENTY_CONVERGENCE && --iterations > 0);
  if (iterations == 0) { return filter_haversine(origin, point); }
  double square = (cos2_alpha * ((FILTER_WGS84_A * FILTER_WGS84_A) - (FILTER_WGS84_B * FILTER_WGS84_B))) /
                  (FILTER_WGS84_B * FILTER_WGS84_B);
  double first =
      1 + ((square / POLYNOMIAL_A_DIVISOR) *
           (POLYNOMIAL_A_FIRST +
            (square * (POLYNOMIAL_A_SECOND + (square * (POLYNOMIAL_A_THIRD - (POLYNOMIAL_A_FOURTH * square)))))));
  double second = (square / POLYNOMIAL_B_DIVISOR) *
                  (POLYNOMIAL_B_FIRST +
                   (square * (POLYNOMIAL_B_SECOND + (square * (POLYNOMIAL_B_THIRD - (POLYNOMIAL_B_FOURTH * square))))));
  double inner = (cos_sigma * (-1 + (2 * cos2_sigma_m * cos2_sigma_m))) -
                 ((second / DELTA_DIVISOR) * cos2_sigma_m * (-3 + (4 * sin_sigma * sin_sigma)) *
                  (-3 + (4 * cos2_sigma_m * cos2_sigma_m)));
  double delta = second * sin_sigma * (cos2_sigma_m + ((second / 4) * inner));
  return FILTER_WGS84_B * first * (sigma - delta);
}
