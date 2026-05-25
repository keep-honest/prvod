import { describe, expect, it, vi } from "vitest";
import { resolveAudioSrc } from "@/lib/storage/resolveAudioSrc";
import type { IStorageService } from "@/interfaces/IStorageService";

function buildStorage(overrides: Partial<IStorageService> = {}): IStorageService {
  return {
    upload: vi.fn(),
    delete: vi.fn(),
    getSignedUrl: vi.fn().mockResolvedValue("https://signed.example/audio.ogg"),
    ...overrides,
  } as IStorageService;
}

describe("resolveAudioSrc", () => {
  it("returns file:// URL when tryGetLocalPath returns an absolute path (local storage)", async () => {
    const storage = buildStorage({
      tryGetLocalPath: vi.fn().mockResolvedValue("/private/tmp/.local-storage/audio/x.ogg"),
    });
    const result = await resolveAudioSrc(storage, "audio/x.ogg", 3600);
    expect(result).toBe("file:///private/tmp/.local-storage/audio/x.ogg");
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it("falls through to getSignedUrl when tryGetLocalPath is unimplemented (remote storage)", async () => {
    const storage = buildStorage(); // no tryGetLocalPath
    const result = await resolveAudioSrc(storage, "audio/x.ogg", 7200);
    expect(result).toBe("https://signed.example/audio.ogg");
    expect(storage.getSignedUrl).toHaveBeenCalledWith("audio/x.ogg", 7200);
  });

  it("throws explicit error when tryGetLocalPath returns null (file missing on local disk)", async () => {
    const storage = buildStorage({
      tryGetLocalPath: vi.fn().mockResolvedValue(null),
    });
    // Must NOT silently fall through to getSignedUrl — that would surface a
    // less useful downstream "not found" error.
    await expect(resolveAudioSrc(storage, "audio/missing.ogg", 60)).rejects.toThrow(
      /Audio key not on local disk after upload: audio\/missing\.ogg/,
    );
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it("propagates errors thrown by tryGetLocalPath (e.g. symlink escape)", async () => {
    const escapeErr = new Error("Key escapes storage directory");
    const storage = buildStorage({
      tryGetLocalPath: vi.fn().mockRejectedValue(escapeErr),
    });
    await expect(resolveAudioSrc(storage, "audio/escape.ogg", 60)).rejects.toBe(escapeErr);
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it("propagates errors thrown by getSignedUrl when no tryGetLocalPath", async () => {
    const signErr = new Error("S3 503");
    const storage = buildStorage({
      getSignedUrl: vi.fn().mockRejectedValue(signErr),
    });
    await expect(resolveAudioSrc(storage, "audio/x.ogg", 60)).rejects.toBe(signErr);
  });

  it("binds `this` so tryGetLocalPath implementations that use this.baseDir work", async () => {
    // The optional-chain call site does `storageService.tryGetLocalPath?.()`,
    // which binds `this` to the service. Our helper uses .call(storageService)
    // to preserve that binding when the method is read off the object.
    class Stub {
      readonly tag = "I-am-this";
      async tryGetLocalPath(_key: string): Promise<string | null> {
        // Touch `this` to prove the binding.
        if (this.tag !== "I-am-this") throw new Error("lost this");
        return "/abs/path.ogg";
      }
      async upload(): Promise<void> {}
      async delete(): Promise<void> {}
      async getSignedUrl(): Promise<string> { return "should-not-be-called"; }
    }
    const result = await resolveAudioSrc(new Stub() as unknown as IStorageService, "audio/x.ogg", 60);
    expect(result).toBe("file:///abs/path.ogg");
  });
});
