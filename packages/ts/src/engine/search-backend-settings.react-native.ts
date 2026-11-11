import { searchInTheCore } from '../core/keyword-score/native'
import { installNativeKeywordSearch } from '../core/partition/search'
import { nativeCoreAnalysis } from '../core/tokenizer/native-analysis'
import { installNativeAnalysis } from '../core/tokenizer/native-hook'

export function requireSearchBackendSettings(): void {
  installNativeAnalysis(nativeCoreAnalysis)
  installNativeKeywordSearch(searchInTheCore)
}
