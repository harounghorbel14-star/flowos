import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Private object storage. Objects are only ever served through the
 * authorized download endpoint — adapters must never expose public URLs.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Keys are random and fanned out into subdirectories; user input never reaches a path. */
export function newStorageKey(): string {
  const id = randomUUID();
  return `${id.slice(0, 2)}/${id}`;
}

const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f-]{36}$/;

export class LocalDiskStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, data, { mode: 0o600, flag: "wx" });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

let storage: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  storage ??= new LocalDiskStorage(path.resolve(process.env.STORAGE_DIR ?? "storage"));
  return storage;
}

/** Test hook. */
export function setStorage(adapter: StorageAdapter) {
  storage = adapter;
}
