#include "HybridNarsilCoreImpl.hpp"
#include "HostMemory.hpp"

#include <cerrno>

namespace margelo::nitro::narsil {

HybridNarsilCoreImpl::~HybridNarsilCoreImpl() {
  if (_workspace != nullptr) narsil_workspace_destroy(_workspace);
  for (auto& entry : _backgroundWorkspaces) narsil_workspace_destroy(entry.second);
}

narsil_workspace* HybridNarsilCoreImpl::claimBackgroundSlot(uint32_t threadSlot) {
  std::lock_guard<std::mutex> guard(_backgroundLock);
  if (_busyBackgroundSlots.count(threadSlot) != 0) throwInvalid("The thread slot is already searching");
  auto found = _backgroundWorkspaces.find(threadSlot);
  narsil_workspace* claimed = found == _backgroundWorkspaces.end() ? nullptr : found->second;
  if (claimed == nullptr) {
    if (narsil_workspace_create(&claimed) != NARSIL_OK) {
      throwSystemError(ENOMEM, "allocate a background search workspace", "");
    }
    std::unique_ptr<narsil_workspace, WorkspaceRelease> pending(claimed);
    _backgroundWorkspaces.emplace(threadSlot, claimed);
    pending.release();
  }
  _busyBackgroundSlots.insert(threadSlot);
  return claimed;
}

void HybridNarsilCoreImpl::releaseBackgroundSlot(uint32_t threadSlot) {
  std::lock_guard<std::mutex> guard(_backgroundLock);
  _busyBackgroundSlots.erase(threadSlot);
}

narsil_workspace* HybridNarsilCoreImpl::workspace() {
  if (_workspace == nullptr && narsil_workspace_create(&_workspace) != NARSIL_OK) {
    _workspace = nullptr;
    throwSystemError(ENOMEM, "allocate the search workspace", "");
  }
  return _workspace;
}

double HybridNarsilCoreImpl::abiVersion() { return narsil_core_abi_version(); }

double HybridNarsilCoreImpl::workspaceBytes() { return static_cast<double>(narsil_workspace_bytes(workspace())); }

}
