import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export interface LogSink {
  error(msg: string, ctx: Record<string, unknown>): void;
}

export interface OpenStreamOptions {
  start: number;
  end: number;
}

/**
 * Open `createReadStream` with an `'error'` listener attached BEFORE
 * the stream is handed to `Readable.toWeb()`.
 *
 * Why this exists: a mid-stream I/O failure (file deleted, permissions
 * changed, disk error after headers sent) emits an unhandled `'error'`
 * event on the Node stream. Without a listener:
 *   - Node may escalate to `uncaughtException` and crash the worker
 *   - The client sees a truncated body with no log on the server
 *
 * This helper attaches the listener synchronously before `toWeb()` so
 * any error event (which fires asynchronously per Node's contract for
 * `createReadStream` — file open happens on next-tick at earliest) is
 * captured. The listener cannot recover the response (headers already
 * flushed when it fires), so it only logs — converting a silent abort
 * into an actionable error event.
 *
 * Extracted from `src/app/api/local-storage/[...key]/route.ts` so the
 * listener-attachment contract is unit-testable without a full Next.js
 * route harness.
 */
export function openStreamWithErrorHandler(
  absolutePath: string,
  key: string,
  logger: LogSink,
  opts?: OpenStreamOptions,
): ReadableStream {
  const nodeStream = opts === undefined
    ? createReadStream(absolutePath)
    : createReadStream(absolutePath, { start: opts.start, end: opts.end });
  nodeStream.on("error", (err) => {
    logger.error("local-storage stream error mid-response", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}
