#include "NativeAtomics.hpp"
#include "HostMemory.hpp"

#include <cmath>
#include <cstdint>

namespace margelo::nitro::narsil {

namespace {

enum AtomicOperation : int {
  ATOMIC_LOAD = 0,
  ATOMIC_STORE = 1,
  ATOMIC_ADD = 2,
  ATOMIC_SUB = 3,
  ATOMIC_AND = 4,
  ATOMIC_OR = 5,
  ATOMIC_XOR = 6,
  ATOMIC_EXCHANGE = 7,
  ATOMIC_COMPARE_EXCHANGE = 8,
};

enum AtomicElementKind : int {
  ELEMENT_INT8 = 0,
  ELEMENT_UINT8 = 1,
  ELEMENT_INT16 = 2,
  ELEMENT_UINT16 = 3,
  ELEMENT_INT32 = 4,
  ELEMENT_UINT32 = 5,
};

constexpr double TWO_TO_THE_32 = 4294967296.0;

uint32_t wrappedToUint32(double value) {
  if (!std::isfinite(value)) return 0;
  double wrapped = std::fmod(std::trunc(value), TWO_TO_THE_32);
  if (wrapped < 0) wrapped += TWO_TO_THE_32;
  return static_cast<uint32_t>(wrapped);
}

template <typename T>
T elementOf(double value) {
  return static_cast<T>(wrappedToUint32(value));
}

template <typename T>
double atomicOn(T* at, int operation, double value, double replacement) {
  T operand = elementOf<T>(value);
  switch (operation) {
    case ATOMIC_LOAD:
      return static_cast<double>(__atomic_load_n(at, __ATOMIC_SEQ_CST));
    case ATOMIC_STORE:
      __atomic_store_n(at, operand, __ATOMIC_SEQ_CST);
      return static_cast<double>(operand);
    case ATOMIC_ADD:
      return static_cast<double>(__atomic_fetch_add(at, operand, __ATOMIC_SEQ_CST));
    case ATOMIC_SUB:
      return static_cast<double>(__atomic_fetch_sub(at, operand, __ATOMIC_SEQ_CST));
    case ATOMIC_AND:
      return static_cast<double>(__atomic_fetch_and(at, operand, __ATOMIC_SEQ_CST));
    case ATOMIC_OR:
      return static_cast<double>(__atomic_fetch_or(at, operand, __ATOMIC_SEQ_CST));
    case ATOMIC_XOR:
      return static_cast<double>(__atomic_fetch_xor(at, operand, __ATOMIC_SEQ_CST));
    case ATOMIC_EXCHANGE:
      return static_cast<double>(__atomic_exchange_n(at, operand, __ATOMIC_SEQ_CST));
    case ATOMIC_COMPARE_EXCHANGE: {
      T expected = operand;
      __atomic_compare_exchange_n(at, &expected, elementOf<T>(replacement), false, __ATOMIC_SEQ_CST,
                                  __ATOMIC_SEQ_CST);
      return static_cast<double>(expected);
    }
    default:
      throwInvalid("An atomic operation is a number from 0 to 8");
  }
}

template <typename T>
double atomicAt(const std::shared_ptr<ArrayBuffer>& buffer, double byteIndex, int operation, double value,
                double replacement) {
  uint8_t* bytes = bytesWithin(buffer, byteIndex, static_cast<double>(sizeof(T)), "The atomic element");
  if (reinterpret_cast<uintptr_t>(bytes) % alignof(T) != 0) throwInvalid("The atomic element is not aligned");
  return atomicOn(reinterpret_cast<T*>(bytes), operation, value, replacement);
}

}

double atomicOnHostMemory(double operation, double elementKind, const std::shared_ptr<ArrayBuffer>& buffer,
                          double byteIndex, double value, double replacement) {
  if (!isHostOwned(buffer)) throwInvalid("Atomic operations run only on memory that the native module allocated");
  int op = static_cast<int>(operation);
  switch (static_cast<int>(elementKind)) {
    case ELEMENT_INT8:
      return atomicAt<int8_t>(buffer, byteIndex, op, value, replacement);
    case ELEMENT_UINT8:
      return atomicAt<uint8_t>(buffer, byteIndex, op, value, replacement);
    case ELEMENT_INT16:
      return atomicAt<int16_t>(buffer, byteIndex, op, value, replacement);
    case ELEMENT_UINT16:
      return atomicAt<uint16_t>(buffer, byteIndex, op, value, replacement);
    case ELEMENT_INT32:
      return atomicAt<int32_t>(buffer, byteIndex, op, value, replacement);
    case ELEMENT_UINT32:
      return atomicAt<uint32_t>(buffer, byteIndex, op, value, replacement);
    default:
      throwInvalid("An atomic element kind is a number from 0 to 5");
  }
}

}
