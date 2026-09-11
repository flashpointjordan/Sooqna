import * as fs from "node:fs";
import * as path from "node:path";

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readArrayFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as T[];
}

export function writeArrayFile<T>(filePath: string, records: T[]): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

export function writeArrayFileAtomically<T>(filePath: string, records: T[]): void {
  ensureDir(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

// Compatibility aliases used by migrated modules.
export const readJsonArrayFile = readArrayFile;
export const writeJsonArrayFile = writeArrayFile;
export const writeJsonArrayFileAtomically = writeArrayFileAtomically;

