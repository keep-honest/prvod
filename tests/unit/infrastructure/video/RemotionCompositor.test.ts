import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CompositionInput } from "@/interfaces/IVideoCompositor";

const bundleMock = vi.fn();
const selectCompositionMock = vi.fn();
const renderMediaMock = vi.fn();
const closeAssetServerMock = vi.fn();
const createReadStreamMock = vi.fn();

interface MockHttpServer {
  on: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
  /** Captured request handler so tests can simulate inbound requests. */
  handler: (req: unknown, res: unknown) => void;
}

let lastMockServer: MockHttpServer | null = null;

function getMockServer(): MockHttpServer {
  if (!lastMockServer) throw new Error("Mock HTTP server was never created");
  return lastMockServer;
}
/** When set, the close mock will NOT invoke its callback (simulates a hung close). */
let stallCloseCallback = false;

vi.mock("node:http", () => ({
  default: {
    createServer: vi.fn((handler: (req: unknown, res: unknown) => void) => {
      const server: MockHttpServer = {
        handler,
        on: vi.fn(),
        listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
        address: vi.fn(() => ({ port: 8123 })),
        close: vi.fn((cb?: () => void) => {
          closeAssetServerMock();
          if (!stallCloseCallback) cb?.();
        }),
        closeAllConnections: vi.fn(),
      };
      lastMockServer = server;
      return server;
    }),
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    createReadStream: (...args: unknown[]) => createReadStreamMock(...args),
  };
});

vi.mock("@remotion/bundler", () => ({
  bundle: bundleMock,
}));

vi.mock("@remotion/renderer", () => ({
  selectComposition: selectCompositionMock,
  renderMedia: renderMediaMock,
}));

function makeInput(): CompositionInput {
  return {
    script: {
      changeType: "feature",
      summary: "summary",
      headline: "headline",
      scenes: [
        {
          sceneNumber: 1,
          sceneType: "overview",
          durationSeconds: 1,
          narration: "Intro",
          codeBroll: [],
        },
        {
          sceneNumber: 2,
          sceneType: "code_walkthrough",
          durationSeconds: 1,
          narration: "Change",
          codeBroll: [],
        },
        {
          sceneNumber: 3,
          sceneType: "summary",
          durationSeconds: 1,
          narration: "Done",
          codeBroll: [],
        },
      ],
      totalDurationSeconds: 3,
      totalWordCount: 3,
      keyFiles: [],
      tags: [],
      narrativeRoles: [],
      voiceAssignments: [],
    },
    clips: [],
    sceneTimelineFrames: [{ sceneNumber: 1, durationFrames: 90 }],
    audioIncluded: false,
  };
}

describe("RemotionCompositor", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    stallCloseCallback = false;
    lastMockServer = null;
    process.env.REMOTION_RENDERER_PORT = "4312";
    bundleMock.mockResolvedValue("/tmp/remotion-bundle");
    selectCompositionMock.mockResolvedValue({
      id: "PRVideo",
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 90,
    });
    renderMediaMock.mockImplementation(async ({ outputLocation }: { outputLocation: string }) => {
      await fs.writeFile(outputLocation, Buffer.from("video"));
    });
    createReadStreamMock.mockImplementation(() => {
      const stream = new EventEmitter() as EventEmitter & { pipe: (dest: unknown) => unknown };
      stream.pipe = (dest: unknown) => dest;
      return stream;
    });
  });

  it("passes the resolved renderer port and Linux multi-process chromium option through to selection and rendering", async () => {
    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");

    await new RemotionCompositor().compose(makeInput());

    expect(selectCompositionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4312,
        chromiumOptions: { enableMultiProcessOnLinux: true },
      }),
    );
    expect(renderMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4312,
        chromiumOptions: { enableMultiProcessOnLinux: true },
      }),
    );
  });

  it("threads the server-resolved WORD_SYNCED_CODE flag through inputProps when enabled", async () => {
    // Root.tsx runs inside the Remotion render bundle (headless Chrome) where
    // custom server env vars are NOT injected — the flag must travel via
    // inputProps or enabling it server-side silently renders the legacy overlay.
    process.env.WORD_SYNCED_CODE = "true";
    try {
      const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");
      await new RemotionCompositor().compose(makeInput());

      expect(selectCompositionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inputProps: expect.objectContaining({ wordSyncedCodeEnabled: true }),
        }),
      );
      expect(renderMediaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inputProps: expect.objectContaining({ wordSyncedCodeEnabled: true }),
        }),
      );
    } finally {
      delete process.env.WORD_SYNCED_CODE;
    }
  });

  it("threads wordSyncedCodeEnabled=false through inputProps when the flag is unset", async () => {
    delete process.env.WORD_SYNCED_CODE;
    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");
    await new RemotionCompositor().compose(makeInput());

    expect(renderMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputProps: expect.objectContaining({ wordSyncedCodeEnabled: false }),
      }),
    );
  });

  it("falls back to the default port when REMOTION_RENDERER_PORT is unset", async () => {
    delete process.env.REMOTION_RENDERER_PORT;
    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");

    await new RemotionCompositor().compose(makeInput());

    expect(selectCompositionMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3300 }),
    );
    expect(renderMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3300 }),
    );
  });

  it("closes the asset server when renderMedia throws", async () => {
    renderMediaMock.mockReset();
    renderMediaMock.mockRejectedValueOnce(new Error("renderer boom"));
    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");

    await expect(new RemotionCompositor().compose(makeInput())).rejects.toThrow(
      "renderer boom",
    );
    expect(closeAssetServerMock).toHaveBeenCalledTimes(1);
  });

  it("calls closeAllConnections before close to avoid keepalive hangs", async () => {
    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");
    await new RemotionCompositor().compose(makeInput());

    const server = getMockServer();
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    const closeOrder = server.closeAllConnections.mock.invocationCallOrder[0];
    const closeInvocationOrder = server.close.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(closeInvocationOrder);
  });

  it("returns from compose even when asset server close hangs (2s timeout race)", async () => {
    stallCloseCallback = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");
    const composePromise = new RemotionCompositor().compose(makeInput());

    // The compose() finally races assetServer.close() against a 2s timeout.
    // With the close callback stalled, the timeout must drive resolution.
    await vi.advanceTimersByTimeAsync(2_500);
    const { videoBuffer } = await composePromise;
    expect(videoBuffer.length).toBeGreaterThan(0);
  });

  it("throws after a successful render if an asset stream errored mid-render", async () => {
    // The asset map's first entry comes from clips. None of our makeInput
    // clips serve files, so seed via per-scene file:// audio.
    const sceneInput: CompositionInput = {
      ...makeInput(),
      sceneTimelineFrames: [
        {
          sceneNumber: 1,
          durationFrames: 90,
          audioSrc: "file:///tmp/scene-1.ogg",
        },
      ],
    };

    // When createReadStream is called for the served audio, return a stream
    // whose pipe() triggers an immediate 'error' emission. The compositor's
    // handler must record this and the post-render check must throw.
    createReadStreamMock.mockImplementation(() => {
      const stream = new EventEmitter() as EventEmitter & {
        pipe: (dest: unknown) => unknown;
      };
      stream.pipe = (dest: unknown) => {
        queueMicrotask(() => stream.emit("error", new Error("disk gone")));
        return dest;
      };
      return stream;
    });

    // Fire the captured request handler against a fake req/res once renderMedia
    // runs — that's when the handler exists and is the moment a real headless
    // browser would request the asset.
    renderMediaMock.mockReset();
    renderMediaMock.mockImplementation(async ({ outputLocation }: { outputLocation: string }) => {
      // Drive the served audio path through the captured server handler.
      const fakeReq = { url: "/scene-1.ogg" };
      const fakeRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        socket: { destroy: vi.fn() },
      };
      getMockServer().handler(fakeReq, fakeRes);
      // Allow the queued microtask (stream error) to fire.
      await Promise.resolve();
      await fs.writeFile(outputLocation, Buffer.from("ok"));
    });

    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");
    await expect(new RemotionCompositor().compose(sceneInput)).rejects.toThrow(
      /Asset stream error during render/,
    );
  });

  it("bundles the Remotion project only once across multiple compose calls (cachedBundlePath reuse)", async () => {
    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");
    const compositor = new RemotionCompositor();

    await compositor.compose(makeInput());
    await compositor.compose(makeInput());
    await new RemotionCompositor().compose(makeInput()); // distinct instance — cache is module-scoped

    expect(bundleMock).toHaveBeenCalledTimes(1);
    // selectComposition + renderMedia called 3× each, all with the same cached serveUrl.
    expect(selectCompositionMock.mock.calls.length).toBe(3);
    expect(renderMediaMock.mock.calls.length).toBe(3);
    for (const [args] of selectCompositionMock.mock.calls) {
      expect(args.serveUrl).toBe("/tmp/remotion-bundle");
    }
    for (const [args] of renderMediaMock.mock.calls) {
      expect(args.serveUrl).toBe("/tmp/remotion-bundle");
    }
  });

  it("serializes the Remotion renderer section across concurrent compose calls", async () => {
    const events: string[] = [];
    let releaseFirstRender: () => void = () => {};

    renderMediaMock
      .mockImplementationOnce(async ({ outputLocation }: { outputLocation: string }) => {
        events.push("first:start");
        await new Promise<void>((resolve) => {
          releaseFirstRender = resolve;
        });
        events.push("first:end");
        await fs.writeFile(outputLocation, Buffer.from("first"));
      })
      .mockImplementationOnce(async ({ outputLocation }: { outputLocation: string }) => {
        events.push("second:start");
        await fs.writeFile(outputLocation, Buffer.from("second"));
      });

    const { RemotionCompositor } = await import("@/infrastructure/video/RemotionCompositor");
    const first = new RemotionCompositor().compose(makeInput());
    const second = new RemotionCompositor().compose(makeInput());

    await vi.waitFor(() => {
      expect(events).toEqual(["first:start"]);
    });

    releaseFirstRender();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });
});
