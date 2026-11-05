import { nativeCoreAnalysis } from '../core/tokenizer/native-analysis'
import { installNativeAnalysis } from '../core/tokenizer/native-hook'
import { requireSearchBackendSettings as requireNativeCoreSettings } from '../vector/native/loader'

export function requireSearchBackendSettings(): void {
  requireNativeCoreSettings()
  installNativeAnalysis(nativeCoreAnalysis)
}
