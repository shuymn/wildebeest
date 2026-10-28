/**
 * Writes every byte through a handle whose write() may write fewer bytes than asked (a short write), and fails
 * rather than loop forever when a write makes no progress.
 * @param {{ write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }> }} handle
 * @param {Uint8Array} bytes
 */
export async function writeAll(handle, bytes) {
  let done = 0;
  while (done < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.byteLength - done);
    if (!(bytesWritten > 0)) {
      throw new Error(`write made no progress after ${done} of ${bytes.byteLength} bytes`);
    }
    done += bytesWritten;
  }
}
