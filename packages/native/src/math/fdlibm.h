#ifndef NARSIL_MATH_FDLIBM_H
#define NARSIL_MATH_FDLIBM_H

#include <stdint.h>

double fdlibm_log(double value);
double fdlibm_sin(double value);
double fdlibm_cos(double value);
double fdlibm_tan(double value);
double fdlibm_asin(double value);
double fdlibm_atan(double value);
double fdlibm_atan2(double rise, double run);

int32_t fdlibm_rem_pio2(double value, double *out);

#endif
