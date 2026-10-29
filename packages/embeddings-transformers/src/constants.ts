export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const DEFAULT_DTYPE = 'fp32'
export const DEFAULT_POOLING = 'mean' as const
export const BATCH_SAFE_DTYPES: readonly string[] = ['fp32', 'fp16']
export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'
export const DEFAULT_RERANK_BATCH_SIZE = 32
export const DEFAULT_RERANK_ACTIVATION = 'sigmoid' as const
