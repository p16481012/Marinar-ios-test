declare const core: {
  MAX_BYTES: number; MAX_FILE_BYTES: number; MAX_FILES: number; FORMAT: string;
  ASSET_ROOTS: Set<string>;
  relativePath(name: string): string; isDataPath(name: string): boolean;
  locations(config: { dataDir: string; envFile: string }): { root: string; stage: string; rollback: string; journal: string };
  exists(path: string): Promise<boolean>;
  hashFile(path: string): Promise<{ size: number; sha256: string }>;
  atomicJson(path: string, value: unknown): Promise<void>;
  readJournal(config: { dataDir: string; envFile: string }): Promise<Record<string, any>>;
  readStoredZip(path: string): Promise<Array<{ name: string; size: number; crc32: number; start: number; offset: number; finish: number }>>;
  extractEntry(archive: string, entry: { name: string; size: number; crc32: number; start: number }, destination: string): Promise<{ size: number; sha256: string }>;
  validateManifest(value: unknown): { files: number; bytes: number };
  validateTree(stage: string, expectedManifestHash?: string): Promise<{ manifest: any; summary: { files: number; bytes: number }; manifestHash: string; key: string }>;
  applyPendingRestore(config: { dataDir: string; envFile: string }): Promise<boolean>;
  finishRestore(config: { dataDir: string; envFile: string }): Promise<void>;
  rollback(config: { dataDir: string; envFile: string }, journal: Record<string, any>): Promise<void>;
};
export = core;
