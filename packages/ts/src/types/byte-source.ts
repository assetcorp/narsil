/**
 * The bytes that {@link Narsil.restore} and {@link Narsil.importDocumentExport}
 * accept, as one array, a stream of chunks, or an async iterable of chunks,
 * such as a Node.js file stream.
 *
 * @public
 */
export type ByteSource = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
