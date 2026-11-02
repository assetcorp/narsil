#pragma once

#include "HybridNarsilHostSpec.hpp"

namespace margelo::nitro::narsil {

class HybridNarsilHostImpl : public HybridNarsilHostSpec {
public:
  HybridNarsilHostImpl() : HybridObject(TAG) {}

  void loadHybridMethods() override;
  jsi::Value collectGarbage(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                            size_t count);

  std::shared_ptr<ArrayBuffer> reserveMemory(double bytes) override;
  std::shared_ptr<ArrayBuffer> allocateMemory(double bytes) override;
  bool ownsMemory(const std::shared_ptr<ArrayBuffer>& buffer) override;
  double atomic(double operation, double elementKind, const std::shared_ptr<ArrayBuffer>& buffer, double byteIndex,
                double value, double replacement) override;
  void fillRandom(const std::shared_ptr<ArrayBuffer>& target, double byteOffset, double byteLength) override;
  double processId() override;
  double processStartedAtMs() override;
  bool processIsAlive(double processId) override;
  ProcessMemory processMemory() override;
  std::string appStorageDirectory() override;
  std::shared_ptr<ArrayBuffer> deflateRaw(const std::shared_ptr<ArrayBuffer>& source, double byteOffset,
                                          double byteLength) override;
  std::shared_ptr<ArrayBuffer> inflateRaw(const std::shared_ptr<ArrayBuffer>& source, double byteOffset,
                                          double byteLength, double rawByteLength) override;
  std::shared_ptr<ArrayBuffer> gzip(const std::shared_ptr<ArrayBuffer>& source, double byteOffset,
                                    double byteLength) override;
  std::shared_ptr<ArrayBuffer> gunzip(const std::shared_ptr<ArrayBuffer>& source, double byteOffset,
                                      double byteLength, double maxByteLength) override;
};

}
