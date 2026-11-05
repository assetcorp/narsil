import { searchInTheCore } from '../core/keyword-score/native'
import { installNativeKeywordSearch } from '../core/partition/search'
import { nativeCoreAnalysis } from '../core/tokenizer/native-analysis'
import { installNativeAnalysis } from '../core/tokenizer/native-hook'
import { requireSearchBackendSettings as requireNativeCoreSettings } from '../vector/native/loader'

export function requireSearchBackendSettings(): void {
  requireNativeCoreSettings()
  installNativeAnalysis(nativeCoreAnalysis)
  installNativeKeywordSearch(searchInTheCore)
}
