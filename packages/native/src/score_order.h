#ifndef NARSIL_SCORE_ORDER_H
#define NARSIL_SCORE_ORDER_H

#include <math.h>

static inline int score_order(double left, double right) {
  if (left == right) { return 0; }
  if (left > right) { return -1; }
  if (left < right) { return 1; }
  if (isnan(left)) { return isnan(right) ? 0 : 1; }
  return -1;
}

#endif
