#include "internal.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

#define LANE_WIDTH 4U
#define UNROLLED_LANES 4U
#define UNROLLED_WIDTH (LANE_WIDTH * UNROLLED_LANES)

#if !defined(NARSIL_PORTABLE_KERNELS) && (defined(__aarch64__) || defined(_M_ARM64))
#include <arm_neon.h>
typedef float32x4_t lanes;
static inline lanes lanes_zero(void) { return vdupq_n_f32(0); }
static inline lanes lanes_load(const float *source) { return vld1q_f32(source); }
static inline lanes lanes_add(lanes lhs, lanes rhs) { return vaddq_f32(lhs, rhs); }
static inline lanes lanes_sub(lanes lhs, lanes rhs) { return vsubq_f32(lhs, rhs); }
static inline lanes lanes_mul(lanes lhs, lanes rhs) { return vmulq_f32(lhs, rhs); }
static inline float lanes_sum_in_pairs(lanes values) {
  return (vgetq_lane_f32(values, 0) + vgetq_lane_f32(values, 1)) +
         (vgetq_lane_f32(values, 2) + vgetq_lane_f32(values, 3));
}
#elif !defined(NARSIL_PORTABLE_KERNELS) && (defined(__SSE2__) || defined(_M_X64))
#include <emmintrin.h>
typedef __m128 lanes;
static inline lanes lanes_zero(void) { return _mm_setzero_ps(); }
static inline lanes lanes_load(const float *source) { return _mm_loadu_ps(source); }
static inline lanes lanes_add(lanes lhs, lanes rhs) { return _mm_add_ps(lhs, rhs); }
static inline lanes lanes_sub(lanes lhs, lanes rhs) { return _mm_sub_ps(lhs, rhs); }
static inline lanes lanes_mul(lanes lhs, lanes rhs) { return _mm_mul_ps(lhs, rhs); }
static inline float lanes_sum_in_pairs(lanes values) {
  float lane[LANE_WIDTH];
  _mm_storeu_ps(lane, values);
  return (lane[0] + lane[1]) + (lane[2] + lane[3]);
}
#else
typedef struct {
  float lane[LANE_WIDTH];
} lanes;
static inline lanes lanes_zero(void) { return (lanes){{0, 0, 0, 0}}; }
static inline lanes lanes_load(const float *source) { return (lanes){{source[0], source[1], source[2], source[3]}}; }
static inline lanes lanes_add(lanes lhs, lanes rhs) {
  return (lanes){
      {lhs.lane[0] + rhs.lane[0], lhs.lane[1] + rhs.lane[1], lhs.lane[2] + rhs.lane[2], lhs.lane[3] + rhs.lane[3]}};
}
static inline lanes lanes_sub(lanes lhs, lanes rhs) {
  return (lanes){
      {lhs.lane[0] - rhs.lane[0], lhs.lane[1] - rhs.lane[1], lhs.lane[2] - rhs.lane[2], lhs.lane[3] - rhs.lane[3]}};
}
static inline lanes lanes_mul(lanes lhs, lanes rhs) {
  return (lanes){
      {lhs.lane[0] * rhs.lane[0], lhs.lane[1] * rhs.lane[1], lhs.lane[2] * rhs.lane[2], lhs.lane[3] * rhs.lane[3]}};
}
static inline float lanes_sum_in_pairs(lanes values) {
  return (values.lane[0] + values.lane[1]) + (values.lane[2] + values.lane[3]);
}
#endif

static inline uint32_t whole_steps(uint32_t count, uint32_t width) { return count - (count % width); }

static inline lanes lane_product(const float *lhs, const float *rhs, size_t lane) {
  return lanes_mul(lanes_load(lhs + (lane * LANE_WIDTH)), lanes_load(rhs + (lane * LANE_WIDTH)));
}

float kernel_dot(const float *lhs, const float *rhs, uint32_t dimension) {
  uint32_t unrolled_end = whole_steps(dimension, UNROLLED_WIDTH);
  uint32_t lanes_end = whole_steps(dimension, LANE_WIDTH);
  lanes sum0 = lanes_zero();
  lanes sum1 = lanes_zero();
  lanes sum2 = lanes_zero();
  lanes sum3 = lanes_zero();
  uint32_t offset = 0;
  for (; offset < unrolled_end; offset += UNROLLED_WIDTH) {
    sum0 = lanes_add(sum0, lane_product(lhs + offset, rhs + offset, 0));
    sum1 = lanes_add(sum1, lane_product(lhs + offset, rhs + offset, 1));
    sum2 = lanes_add(sum2, lane_product(lhs + offset, rhs + offset, 2));
    sum3 = lanes_add(sum3, lane_product(lhs + offset, rhs + offset, 3));
  }
  for (; offset < lanes_end; offset += LANE_WIDTH) {
    sum0 = lanes_add(sum0, lane_product(lhs + offset, rhs + offset, 0));
  }
  float sum = lanes_sum_in_pairs(lanes_add(lanes_add(sum0, sum1), lanes_add(sum2, sum3)));
  for (; offset < dimension; offset++) { sum = sum + (lhs[offset] * rhs[offset]); }
  return sum;
}

float kernel_squared_distance(const float *lhs, const float *rhs, uint32_t dimension) {
  uint32_t lanes_end = whole_steps(dimension, LANE_WIDTH);
  lanes running = lanes_zero();
  uint32_t offset = 0;
  for (; offset < lanes_end; offset += LANE_WIDTH) {
    lanes difference = lanes_sub(lanes_load(lhs + offset), lanes_load(rhs + offset));
    running = lanes_add(running, lanes_mul(difference, difference));
  }
  float sum = lanes_sum_in_pairs(running);
  for (; offset < dimension; offset++) {
    float difference = lhs[offset] - rhs[offset];
    sum = sum + (difference * difference);
  }
  return sum;
}

float kernel_magnitude(const float *values, uint32_t dimension) {
  uint32_t lanes_end = whole_steps(dimension, LANE_WIDTH);
  lanes running = lanes_zero();
  uint32_t offset = 0;
  for (; offset < lanes_end; offset += LANE_WIDTH) {
    lanes loaded = lanes_load(values + offset);
    running = lanes_add(running, lanes_mul(loaded, loaded));
  }
  float sum = lanes_sum_in_pairs(running);
  for (; offset < dimension; offset++) { sum = sum + (values[offset] * values[offset]); }
  return sqrtf(sum);
}
