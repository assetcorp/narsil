#pragma once

#include "HybridNarsilCoreSpec.hpp"
#include "narsil_core.h"

#include <cstdint>
#include <mutex>
#include <unordered_map>
#include <unordered_set>

namespace margelo::nitro::narsil {

class HybridNarsilCoreImpl : public HybridNarsilCoreSpec {
public:
  HybridNarsilCoreImpl() : HybridObject(TAG) {}
  ~HybridNarsilCoreImpl() override;

  double abiVersion() override;
  double workspaceBytes() override;
  std::shared_ptr<HybridNarsilAttachedGraphSpec> attachGraph(const GraphMemory& memory) override;
  std::shared_ptr<HybridNarsilAttachedStoreSpec> attachStore(const StoreMemory& memory) override;
  double search(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, const MemoryView& query, double metric,
                double candidateCount, double threadSlot, const MemoryView& ordinals, const MemoryView& distances,
                const MemoryView& accepted, bool filtered) override;
  double score(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, const MemoryView& query, double metric,
               const MemoryView& ordinals, double count, const MemoryView& distances) override;
  std::shared_ptr<Promise<NativeSearchHits>> searchAsync(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                                                         const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store,
                                                         const MemoryView& query, double metric,
                                                         double candidateCount, double threadSlot,
                                                         const MemoryView& accepted, bool filtered) override;
  std::shared_ptr<Promise<NativeScores>> scoreAsync(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store,
                                                    const MemoryView& query, double metric,
                                                    const MemoryView& ordinals, double count,
                                                    double threadSlot) override;
  double place(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
               const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric, double ordinal,
               double topLayer, double graphHeldAlone, double threadSlot, const MemoryView& wakes) override;
  double remove(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph, double ordinal, double threadSlot,
                const MemoryView& wakes) override;
  double compact(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                 const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric, double threadSlot,
                 const MemoryView& wakes) override;
  double connectUnreached(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                          const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric,
                          const MemoryView& nearby, double threadSlot, const MemoryView& wakes) override;
  std::shared_ptr<Promise<NativeConnectOutcome>> connectUnreachedAsync(
      const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
      const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric, const MemoryView& nearby,
      double threadSlot) override;
  double measure(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric,
                 const MemoryView& ordinals, double count, const MemoryView& totals) override;
  double quantise(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric,
                  const MemoryView& ordinals, double count) override;

  narsil_workspace* claimBackgroundSlot(uint32_t threadSlot);
  void releaseBackgroundSlot(uint32_t threadSlot);

private:
  narsil_workspace* workspace();
  narsil_workspace* _workspace = nullptr;
  std::mutex _backgroundLock;
  std::unordered_map<uint32_t, narsil_workspace*> _backgroundWorkspaces;
  std::unordered_set<uint32_t> _busyBackgroundSlots;
};

}
