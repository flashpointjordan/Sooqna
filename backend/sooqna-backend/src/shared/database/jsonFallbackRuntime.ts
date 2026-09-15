import * as path from "node:path";

export const jsonFallbackRuntimeDirectory = path.resolve(
  process.env.SOOQNA_JSON_FALLBACK_DATA_DIR?.trim() || path.join(process.cwd(), ".runtime-data", "json-fallback")
);

export function jsonFallbackRuntimePath(fileName: string): string {
  return path.join(jsonFallbackRuntimeDirectory, fileName);
}
