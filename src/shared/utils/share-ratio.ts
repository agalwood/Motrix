/** Share ratio against the task payload size, including upload from retired sessions. */
export function shareRatio(uploadedBytes: number, totalBytes: number): number {
  return totalBytes > 0 &&
    Number.isFinite(totalBytes) &&
    Number.isFinite(uploadedBytes)
    ? Math.max(0, uploadedBytes) / totalBytes
    : 0
}
