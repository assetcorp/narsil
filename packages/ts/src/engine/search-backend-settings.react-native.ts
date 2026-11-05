import { nativeCoreAnalysis } from '../core/tokenizer/native-analysis'
import { installNativeAnalysis } from '../core/tokenizer/native-hook'

export function requireSearchBackendSettings(): void {
  installNativeAnalysis(nativeCoreAnalysis)
}
