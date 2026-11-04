#include "WorkletRuntimeDispatcher.hpp"

#if NARSIL_LINKS_WORKLETS

#include <NitroModules/Dispatcher.hpp>
#include <worklets/WorkletRuntime/WorkletRuntime.h>

#include <functional>
#include <memory>
#include <stdexcept>
#include <utility>

namespace margelo::nitro::narsil {

namespace {

class WorkletRuntimeDispatcher final : public Dispatcher {
public:
  explicit WorkletRuntimeDispatcher(std::weak_ptr<worklets::WorkletRuntime> runtime) : _runtime(std::move(runtime)) {}

  void runAsync(std::function<void()>&& function) override {
    std::shared_ptr<worklets::WorkletRuntime> runtime = _runtime.lock();
    if (runtime == nullptr) return;
    runtime->schedule([function = std::move(function)](facebook::jsi::Runtime&) { function(); });
  }

  void runSync(std::function<void()>&& function) override {
    std::shared_ptr<worklets::WorkletRuntime> runtime = _runtime.lock();
    if (runtime == nullptr) return;
    runtime->runSync([&function](facebook::jsi::Runtime&) { function(); });
  }

private:
  std::weak_ptr<worklets::WorkletRuntime> _runtime;
};

}

bool installWorkletRuntimeDispatcher(facebook::jsi::Runtime& runtime) {
  std::weak_ptr<worklets::WorkletRuntime> workletRuntime;
  try {
    workletRuntime = worklets::WorkletRuntime::getWeakRuntimeFromJSIRuntime(runtime);
  } catch (const std::runtime_error&) {
    return false;
  }
  if (workletRuntime.expired()) return false;
  Dispatcher::installRuntimeGlobalDispatcher(runtime, std::make_shared<WorkletRuntimeDispatcher>(workletRuntime));
  return true;
}

}

#else

namespace margelo::nitro::narsil {

bool installWorkletRuntimeDispatcher(facebook::jsi::Runtime&) { return false; }

}

#endif
