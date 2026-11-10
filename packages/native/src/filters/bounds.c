#include "geo.h"
#include "geo_constants.h"
#include "radius.h"

#include <math.h>

static const double COSINE_SECOND = -1.0 / 2;
static const double COSINE_FOURTH = 1.0 / 24;
static const double COSINE_SIXTH = -1.0 / 720;
static const double COSINE_EIGHTH = 1.0 / 40320;
static const double COSINE_TENTH = -1.0 / 3628800;
static const double COSINE_TWELFTH = 1.0 / 479001600;
static const double COSINE_FOURTEENTH = -1.0 / 87178291200;
static const double COSINE_SIXTEENTH = 1.0 / 20922789888000;
static const double SINE_THIRD = -1.0 / 6;
static const double SINE_FIFTH = 1.0 / 120;
static const double SINE_SEVENTH = -1.0 / 5040;
static const double SINE_NINTH = 1.0 / 362880;
static const double SINE_ELEVENTH = -1.0 / 39916800;
static const double SINE_THIRTEENTH = 1.0 / 6227020800;
static const double SINE_FIFTEENTH = -1.0 / 1307674368000;
static const double SINE_SEVENTEENTH = 1.0 / 355687428096000;
static const double SINE_SQUARE_FOURTH = 1.0 / 3;
static const double SINE_SQUARE_SIXTH = 2.0 / 45;
static const double COSINE_STEP_DIVISOR = 24;
static const double SINE_STEP_DIVISOR = 6;
static const double SINE_STEP_END_DIVISOR = 120;

double filter_sine_square_low(double square) { return square - (square * square * SINE_SQUARE_FOURTH); }

double filter_sine_square_high(double square) {
  return filter_sine_square_low(square) + (square * square * square * SINE_SQUARE_SIXTH);
}

filter_chord_origin filter_chord_origin_of(filter_point point) {
  double phi = point.lat * FILTER_DEGREES_TO_RADIANS;
  double square = phi * phi;
  double fourth = square * square * (square * square);
  double cosine =
      1 +
      (square *
       (COSINE_SECOND +
        (square *
         (COSINE_FOURTH +
          (square *
           (COSINE_SIXTH +
            (square * (COSINE_EIGHTH +
                       (square * (COSINE_TENTH + (square * (COSINE_TWELFTH + (square * COSINE_FOURTEENTH)))))))))))));
  double magnitude = fabs(phi);
  double sine =
      magnitude *
      (1 + (square *
            (SINE_THIRD +
             (square *
              (SINE_FIFTH +
               (square *
                (SINE_SEVENTH +
                 (square * (SINE_NINTH + (square * (SINE_ELEVENTH +
                                                    (square * (SINE_THIRTEENTH + (square * SINE_FIFTEENTH))))))))))))));
  double sine_high = sine + (magnitude * fourth * fourth * SINE_SEVENTEENTH) + FILTER_COSINE_SLACK;
  double sine_low = sine - FILTER_COSINE_SLACK;
  return (filter_chord_origin){point,
                               phi,
                               fmax(0, cosine - FILTER_COSINE_SLACK),
                               cosine + (fourth * fourth * COSINE_SIXTEENTH) + FILTER_COSINE_SLACK,
                               phi < 0 ? -sine_high : sine_low,
                               phi < 0 ? -sine_low : sine_high};
}

int filter_bound_chord(const filter_chord_origin *origin, filter_point point, filter_chord_bounds *bounds) {
  double half_phi = ((point.lat - origin->point.lat) * FILTER_DEGREES_TO_RADIANS) / 2;
  double half_lambda = ((point.lon - origin->point.lon) * FILTER_DEGREES_TO_RADIANS) / 2;
  double step = (point.lat * FILTER_DEGREES_TO_RADIANS) - origin->phi;
  double phi_square = half_phi * half_phi;
  double lambda_square = half_lambda * half_lambda;
  double step_square = step * step;
  if (!(phi_square <= FILTER_CHORD_MAX_SQUARE && lambda_square <= FILTER_CHORD_MAX_SQUARE &&
        step_square <= FILTER_CHORD_MAX_SQUARE)) {
    return 0;
  }
  double step_cosine_low = 1 - (step_square / 2);
  double step_cosine_high = step_cosine_low + ((step_square * step_square) / COSINE_STEP_DIVISOR);
  double step_sine = step - ((step * step_square) / SINE_STEP_DIVISOR);
  double step_sine_end = step_sine + ((step * step_square * step_square) / SINE_STEP_END_DIVISOR);
  double step_sine_low = fmin(step_sine, step_sine_end);
  double step_sine_high = fmax(step_sine, step_sine_end);
  double first = origin->sine_low * step_sine_low;
  double second = origin->sine_low * step_sine_high;
  double third = origin->sine_high * step_sine_low;
  double fourth = origin->sine_high * step_sine_high;
  double turn_low = fmin(fmin(first, second), fmin(third, fourth));
  double turn_high = fmax(fmax(first, second), fmax(third, fourth));
  double cosine_low = fmax(0, (origin->cosine_low * step_cosine_low) - turn_high - FILTER_COSINE_SLACK);
  double cosine_high = (origin->cosine_high * step_cosine_high) - turn_low + FILTER_COSINE_SLACK;
  bounds->lower =
      (filter_sine_square_low(phi_square) + (origin->cosine_low * cosine_low * filter_sine_square_low(lambda_square))) *
      (1 - FILTER_CHORD_SLACK);
  bounds->upper = (filter_sine_square_high(phi_square) +
                   (origin->cosine_high * cosine_high * filter_sine_square_high(lambda_square))) *
                  (1 + FILTER_CHORD_SLACK);
  return 1;
}
