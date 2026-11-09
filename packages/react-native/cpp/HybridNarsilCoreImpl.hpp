#pragma once

#include "HybridNarsilCoreSpec.hpp"
#include "narsil_analysis.h"
#include "narsil_core.h"
#include "narsil_keyword.h"

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace margelo::nitro::narsil {

struct AnalyserRelease {
  void operator()(narsil_analyser* analyser) const { narsil_analyser_destroy(analyser); }
};

inline constexpr size_t KEYWORD_SCORE_ARGUMENT_COUNT = 23;
inline constexpr size_t FUSION_ARGUMENT_COUNT = 10;
inline constexpr size_t MERGE_RANKINGS_ARGUMENT_COUNT = 6;
inline constexpr size_t MERGE_SORTED_ARGUMENT_COUNT = 5;
inline constexpr size_t PINNED_ARGUMENT_COUNT = 5;
inline constexpr size_t FACET_MERGE_ARGUMENT_COUNT = 10;
inline constexpr size_t GROUP_MERGE_ARGUMENT_COUNT = 13;
inline constexpr size_t GROUP_HITS_ARGUMENT_COUNT = 10;
inline constexpr size_t PAGE_START_ARGUMENT_COUNT = 6;
inline constexpr size_t SORT_VALUE_ARGUMENT_COUNT = 5;
inline constexpr size_t SORT_ORDER_ARGUMENT_COUNT = 7;
inline constexpr size_t TEXT_RANGE_ARGUMENT_COUNT = 7;
inline constexpr size_t BOOLEAN_FACET_ARGUMENT_COUNT = 4;
inline constexpr size_t NUMERIC_FACET_ARGUMENT_COUNT = 5;
inline constexpr size_t ENUM_FACET_ARGUMENT_COUNT = 4;
inline constexpr size_t VALUE_FACET_ARGUMENT_COUNT = 4;
inline constexpr size_t STORED_RANGE_FACET_ARGUMENT_COUNT = 4;
inline constexpr size_t SORT_SELECT_ARGUMENT_COUNT = 8;
inline constexpr size_t FILTER_ARGUMENT_COUNT = 10;
inline constexpr size_t PATTERN_ARGUMENT_COUNT = 11;
inline constexpr size_t LOOKUP_EXACT_ARGUMENT_COUNT = 3;
inline constexpr size_t LOOKUP_EXACT_BATCH_ARGUMENT_COUNT = 4;
inline constexpr size_t LOOKUP_PREFIX_ARGUMENT_COUNT = 4;
inline constexpr size_t LOOKUP_TYPO_ARGUMENT_COUNT = 5;
inline constexpr size_t DOCUMENT_FREQUENCY_ARGUMENT_COUNT = 3;
inline constexpr size_t EXPAND_SYNONYMS_ARGUMENT_COUNT = 6;
inline constexpr size_t EXPAND_PREFIX_ARGUMENT_COUNT = 7;
inline constexpr size_t EXPAND_PARTIAL_ARGUMENT_COUNT = 6;
inline constexpr size_t SUGGEST_TERMS_ARGUMENT_COUNT = 8;
inline constexpr size_t HIGHLIGHT_ARGUMENT_COUNT = 9;
inline constexpr size_t MATCH_PHRASES_ARGUMENT_COUNT = 9;
inline constexpr size_t INDEX_TERMS_ARGUMENT_COUNT = 3;
inline constexpr size_t INDEX_TERMS_FIELD_VALUES = 3;
inline constexpr size_t KEYWORD_BATCH_ARGUMENT_COUNT = 2;
inline constexpr size_t REMOVE_FROZEN_ARGUMENT_COUNT = 33;
inline constexpr size_t PREPARE_FROZEN_ARGUMENT_COUNT = 35;
inline constexpr size_t SETTLE_FROZEN_ARGUMENT_COUNT = 31;

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
  jsi::Value analysePacked(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                           size_t count);
  jsi::Value transform(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value keywordScore(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                          size_t count);
  jsi::Value fuse(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value mergeRankings(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                           size_t count);
  jsi::Value mergeSorted(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                         size_t count);
  jsi::Value placePinned(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                         size_t count);
  jsi::Value mergeFacets(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                         size_t count);
  jsi::Value mergeGroups(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                         size_t count);
  jsi::Value groupHits(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                       size_t count);
  jsi::Value pageStart(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                       size_t count);
  jsi::Value sortValue(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                       size_t count);
  jsi::Value buildSortOrder(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                            size_t count);
  jsi::Value textRange(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                       size_t count);
  jsi::Value sortSelect(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                       size_t count);
  jsi::Value booleanFacet(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                          size_t count);
  jsi::Value numberFacet(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                         size_t count);
  jsi::Value rangeFacet(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                        size_t count);
  jsi::Value enumFacet(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                       size_t count);
  jsi::Value valueFacet(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                        size_t count);
  jsi::Value storedRangeFacet(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                              size_t count);
  jsi::Value evaluateFilter(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                           size_t count);
  jsi::Value patternTest(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                        size_t count);
  jsi::Value clockNow(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments,
                     size_t count);
  jsi::Value lookupExact(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value lookupExactBatch(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value lookupPrefix(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value lookupTypo(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value documentFrequency(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value lookupTerms(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, uint32_t operation);
  jsi::Value expandSynonyms(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value expandPrefix(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value expandPartialWords(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value suggestTerms(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value highlight(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value openPagedFile(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value closePagedFile(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPage(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPageAsync(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPagedPostings(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPagedPositions(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPagedRemovals(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPagedId(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPagedOrdinal(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPagedWriteRecord(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value readPagedTotals(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value searchPagedVectors(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value searchPagedVectorsAsync(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value matchPhrases(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value indexTerms(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value removeDocument(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value removeFrozenDocument(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value prepareFrozenRemoval(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value settleFrozenState(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value beginBatch(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value endBatch(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value measureMerge(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value writeMerge(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value mergePostings(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value measureFieldMerge(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);
  jsi::Value writeFieldMerge(jsi::Runtime& runtime, const jsi::Value& thisValue, const jsi::Value* arguments, size_t count);

  double abiVersion() override;
  double workspaceBytes() override;
  std::shared_ptr<HybridNarsilAttachedGraphSpec> attachGraph(const GraphMemory& memory) override;
  std::shared_ptr<HybridNarsilAttachedStoreSpec> attachStore(const StoreMemory& memory) override;
  double search(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, const MemoryView& query, double metric,
                double candidateCount, double pin, double threadSlot, const MemoryView& ordinals,
                const MemoryView& distances, const MemoryView& accepted, bool filtered) override;
  double score(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, const MemoryView& query, double metric,
               const MemoryView& ordinals, double count, double pin, const MemoryView& distances) override;
  std::shared_ptr<Promise<NativeSearchHits>> searchAsync(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                                                         const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store,
                                                         const MemoryView& query, double metric,
                                                         double candidateCount, double pin, double threadSlot,
                                                         const MemoryView& accepted, bool filtered) override;
  std::shared_ptr<Promise<NativeScores>> scoreAsync(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store,
                                                    const MemoryView& query, double metric,
                                                    const MemoryView& ordinals, double count, double pin,
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
  narsil_workspace* pagedWorkspace(jsi::Runtime& runtime);
  jsi::Value pagedVectors(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, bool asynchronous);
  jsi::Value fieldMerge(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, bool writing);
  jsi::Value keywordMerge(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, bool writing);
  jsi::Value frozenDocument(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, bool preparing);
  jsi::Value keywordBatch(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, bool ending);
  jsi::Value mutateDocument(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, bool removing);
  jsi::Value numericFacet(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, bool ranges);
  jsi::Value merge(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count, bool scored);
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
