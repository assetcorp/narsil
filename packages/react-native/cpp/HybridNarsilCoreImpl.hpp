#pragma once

#include "HybridNarsilCoreSpec.hpp"
#include "narsil_analysis.h"
#include "narsil_core.h"
#include "narsil_keyword.h"

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace margelo::nitro::narsil {

struct AnalyserRelease {
  void operator()(narsil_analyser* analyser) const { narsil_analyser_destroy(analyser); }
};

inline constexpr size_t KEYWORD_SCORE_ARGUMENT_COUNT = 23;

struct WorkspaceRelease {
  void operator()(narsil_workspace* workspace) const { narsil_workspace_destroy(workspace); }
};

class HybridNarsilCoreImpl : public HybridNarsilCoreSpec {
public:
  HybridNarsilCoreImpl() : HybridObject(TAG) {}
  ~HybridNarsilCoreImpl() override;

  void loadHybridMethods() override;
  jsi::Value languageCount(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                           size_t count);
  jsi::Value languageName(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                          size_t count);
  jsi::Value languageRevision(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                              size_t count);
  jsi::Value languageStopWords(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                               size_t count);
  jsi::Value createStopWordSet(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                               size_t count);
  jsi::Value analyse(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value transform(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value keywordScore(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                          size_t count);

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
  double applyMath(double operation, const MemoryView& first, const MemoryView& second,
                   const MemoryView& results) override;

  narsil_workspace* claimBackgroundSlot(uint32_t threadSlot);
  void releaseBackgroundSlot(uint32_t threadSlot);

private:
  struct RuntimeState {
    std::unique_ptr<narsil_analyser, AnalyserRelease> analyser;
    std::vector<uint16_t> textUnits;
    std::u16string textOut;
    std::unique_ptr<narsil_workspace, WorkspaceRelease> keywordWorkspace;
    std::vector<narsil_keyword_column> keywordLengths;
  };
  RuntimeState& stateOf(jsi::Runtime& runtime);
  std::mutex _runtimeStateLock;
  std::unordered_map<jsi::Runtime*, std::unique_ptr<RuntimeState>> _stateByRuntime;
  narsil_workspace* workspace();
  narsil_workspace* _workspace = nullptr;
  std::mutex _backgroundLock;
  std::unordered_map<uint32_t, narsil_workspace*> _backgroundWorkspaces;
  std::unordered_set<uint32_t> _busyBackgroundSlots;
};

}
