// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null

export async function getEmbedding(text: string): Promise<Float32Array> {
  if (!embedder) {
    const { pipeline } = await import('@xenova/transformers')
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    console.log('[Embeddings] model loaded: all-MiniLM-L6-v2')
  }

  const output = await embedder(text, { pooling: 'mean', normalize: true })
  return output.data as Float32Array
}

/** Embedding dimension for all-MiniLM-L6-v2 */
export const EMBEDDING_DIM = 384

/** Warm up the embedding model on startup so first message is fast */
export async function warmupEmbeddings(): Promise<void> {
  console.log('⏳ Loading embedding model...')
  await getEmbedding('warmup ping')
  console.log('✓ Embedding model ready')
}
