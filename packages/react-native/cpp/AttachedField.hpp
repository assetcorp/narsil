#pragma once

#include "GraphMemory.hpp"
#include "HybridNarsilAttachedGraphSpec.hpp"
#include "HybridNarsilAttachedStoreSpec.hpp"
#include "StoreMemory.hpp"
#include "narsil_core.h"

#include <cstdint>
#include <memory>
#include <vector>

namespace margelo::nitro::narsil {

constexpr uint32_t WAKES_KEPT_PER_CALL = 256;

struct PendingWakes {
  int32_t ordinals[WAKES_KEPT_PER_CALL];
  uint32_t count = 0;
};

class HybridNarsilAttachedGraphImpl final : public HybridNarsilAttachedGraphSpec {
public:
  explicit HybridNarsilAttachedGraphImpl(const GraphMemory& memory);
  narsil_graph graph{};
  PendingWakes wakes;

private:
  std::vector<std::shared_ptr<ArrayBuffer>> _held;
};

class HybridNarsilAttachedStoreImpl final : public HybridNarsilAttachedStoreSpec {
public:
  explicit HybridNarsilAttachedStoreImpl(const StoreMemory& memory);
  ~HybridNarsilAttachedStoreImpl() override;
  double detach() override;
  bool isDetached() const { return _detached; }
  narsil_store store{};

private:
  void unmapFiles();
  std::vector<std::shared_ptr<ArrayBuffer>> _held;
  std::vector<uint8_t*> _codeBlocks;
  std::vector<const float*> _vectorBlocks;
  std::vector<narsil_vector_file> _files;
  bool _detached = false;
};

std::shared_ptr<HybridNarsilAttachedGraphImpl> attachedGraphOf(
    const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph);
std::shared_ptr<HybridNarsilAttachedStoreImpl> attachedStoreOf(
    const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store);
uint32_t handOverWakes(PendingWakes& wakes, const MemoryView& target);

}
