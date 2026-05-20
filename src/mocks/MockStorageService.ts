import type { IStorageService } from "@/interfaces/IStorageService";

interface MockStorageStore {
  objects: Map<string, Buffer>;
}

type GlobalWithMockStorage = typeof globalThis & {
  __prvodMockStorageStore?: MockStorageStore;
};

function getGlobalMockStorageStore(): MockStorageStore {
  const globalScope = globalThis as GlobalWithMockStorage;
  if (!globalScope.__prvodMockStorageStore) {
    globalScope.__prvodMockStorageStore = { objects: new Map<string, Buffer>() };
  }
  return globalScope.__prvodMockStorageStore;
}

export class MockStorageService implements IStorageService {
  private readonly store: Map<string, Buffer>;

  constructor() {
    this.store = process.env.USE_MOCK_SERVICES === "true"
      ? getGlobalMockStorageStore().objects
      : new Map<string, Buffer>();
  }

  async upload(key: string, data: Buffer, _contentType: string): Promise<void> {
    this.store.set(key, data);
  }

  async getSignedUrl(key: string, _expirySeconds: number): Promise<string> {
    if (!this.store.has(key)) {
      throw new Error(`Object not found: ${key}`);
    }
    return `https://mock-r2.example.com/${key}?token=mock-signed-token&expires=9999999999`;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Test helper: check if an object exists */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Test helper: read an uploaded artifact's raw bytes */
  get(key: string): Buffer | undefined {
    return this.store.get(key);
  }
}
