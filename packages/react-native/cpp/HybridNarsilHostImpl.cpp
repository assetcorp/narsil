#include "HybridNarsilHostImpl.hpp"
#include "Compression.hpp"
#include "HostMemory.hpp"
#include "NativeAtomics.hpp"
#include "ProcessInfo.hpp"

#include <cerrno>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <jsi/instrumentation.h>
#include <unistd.h>

namespace margelo::nitro::narsil {

namespace {

double millisecondsSinceEpoch() {
  auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

const double LIBRARY_LOADED_AT_MS = millisecondsSinceEpoch();

const char* const GARBAGE_COLLECTION_CAUSE = "narsil-memory-limit";

}

void HybridNarsilHostImpl::loadHybridMethods() {
  HybridNarsilHostSpec::loadHybridMethods();
  registerHybrids(this, [](Prototype& prototype) {
    prototype.registerRawHybridMethod("collectGarbage", 0, &HybridNarsilHostImpl::collectGarbage);
  });
}

jsi::Value HybridNarsilHostImpl::collectGarbage(jsi::Runtime& runtime, const jsi::Value&, const jsi::Value*,
                                                size_t) {
  runtime.instrumentation().collectGarbage(GARBAGE_COLLECTION_CAUSE);
  return jsi::Value(true);
}

std::shared_ptr<ArrayBuffer> HybridNarsilHostImpl::reserveMemory(double bytes) { return reserveRegion(bytes); }

std::shared_ptr<ArrayBuffer> HybridNarsilHostImpl::allocateMemory(double bytes) { return allocateZeroed(bytes); }

bool HybridNarsilHostImpl::ownsMemory(const std::shared_ptr<ArrayBuffer>& buffer) { return isHostOwned(buffer); }

double HybridNarsilHostImpl::atomic(double operation, double elementKind, const std::shared_ptr<ArrayBuffer>& buffer,
                                    double byteIndex, double value, double replacement) {
  return atomicOnHostMemory(operation, elementKind, buffer, byteIndex, value, replacement);
}

void HybridNarsilHostImpl::fillRandom(const std::shared_ptr<ArrayBuffer>& target, double byteOffset,
                                      double byteLength) {
  uint8_t* bytes = bytesWithin(target, byteOffset, byteLength, "The random byte target");
  if (bytes != nullptr) arc4random_buf(bytes, static_cast<size_t>(byteLength));
}

double HybridNarsilHostImpl::processId() { return static_cast<double>(getpid()); }

double HybridNarsilHostImpl::processStartedAtMs() { return LIBRARY_LOADED_AT_MS; }

bool HybridNarsilHostImpl::processIsAlive(double processId) {
  if (!std::isfinite(processId) || processId <= 0 || std::floor(processId) != processId || processId > INT32_MAX) {
    return false;
  }
  return kill(static_cast<pid_t>(processId), 0) == 0;
}

ProcessMemory HybridNarsilHostImpl::processMemory() {
  return ProcessMemory(residentBytesOfThisProcess(), availableBytesForThisProcess());
}

std::string HybridNarsilHostImpl::appStorageDirectory() { return privateStorageDirectory(); }

std::shared_ptr<ArrayBuffer> HybridNarsilHostImpl::deflateRaw(const std::shared_ptr<ArrayBuffer>& source,
                                                              double byteOffset, double byteLength) {
  uint8_t* bytes = bytesWithin(source, byteOffset, byteLength, "The bytes to compress");
  return compressBytes(bytes, static_cast<size_t>(byteLength), CompressionFormat::RawDeflate);
}

std::shared_ptr<ArrayBuffer> HybridNarsilHostImpl::inflateRaw(const std::shared_ptr<ArrayBuffer>& source,
                                                              double byteOffset, double byteLength,
                                                              double rawByteLength) {
  uint8_t* bytes = bytesWithin(source, byteOffset, byteLength, "The bytes to decompress");
  size_t limit = requireByteCount(rawByteLength, "The decompressed length");
  return inflateBytes(bytes, static_cast<size_t>(byteLength), CompressionFormat::RawDeflate, limit);
}

std::shared_ptr<ArrayBuffer> HybridNarsilHostImpl::gzip(const std::shared_ptr<ArrayBuffer>& source,
                                                        double byteOffset, double byteLength) {
  uint8_t* bytes = bytesWithin(source, byteOffset, byteLength, "The bytes to compress");
  return compressBytes(bytes, static_cast<size_t>(byteLength), CompressionFormat::Gzip);
}

std::shared_ptr<ArrayBuffer> HybridNarsilHostImpl::gunzip(const std::shared_ptr<ArrayBuffer>& source,
                                                          double byteOffset, double byteLength,
                                                          double maxByteLength) {
  uint8_t* bytes = bytesWithin(source, byteOffset, byteLength, "The bytes to decompress");
  size_t limit = requireByteCount(maxByteLength, "The decompressed length limit");
  return inflateBytes(bytes, static_cast<size_t>(byteLength), CompressionFormat::Gzip, limit);
}

}
