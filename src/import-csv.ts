// R2 ranges are byte offsets. Find a complete line in the raw bytes before
// decoding so an accented stop name cannot shift the next read into a row.
export async function readCsvChunk(
  bucket: R2Bucket,
  key: string,
  size: number,
  offset: number,
  chunkSize: number,
  header: string,
) {
  let length = Math.min(chunkSize, size - offset);
  while (true) {
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object) throw new Error(`Missing staged GTFS file: ${key}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== length) throw new Error(`Short R2 read for ${key}`);

    const processedBytes =
      offset + length === size ? length : bytes.lastIndexOf(10) + 1;
    if (processedBytes === 0) {
      // A single CSV record may be larger than the usual chunk.
      length = Math.min(length * 2, size - offset);
      continue;
    }

    const text = new TextDecoder().decode(bytes.subarray(0, processedBytes));
    const currentHeader = offset === 0 ? text.split("\n", 1)[0].trim() : header;
    const csvContent = offset === 0 ? text : currentHeader + "\n" + text;
    return { csvContent, processedBytes, currentHeader };
  }
}
