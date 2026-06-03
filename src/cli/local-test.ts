#!/usr/bin/env node
import { execFileSync } from "child_process";
import { writeFileSync, createReadStream, statSync, openSync, readSync, closeSync } from "fs";
import { resolve as resolvePath } from "path";
import { Readable } from "stream";

// --- Arg parsing ---

interface CliArgs {
  serverUrl: string;
  apiKey: string;
  scriptOnly: boolean;
  ttsOnly: boolean;
  deepdive: boolean;
  shortDur: boolean;
  popcorn: boolean;
  output: string | null;
  uncommitted: boolean;
  prNumber: number;
  title: string | null;
  retryJob: string | null;
  maxPolls: number | null;
  pollIntervalMs: number;
  diffFile: string | null;
  streamDiff: boolean;
}

const DEFAULT_GIT_MAX_BUFFER_MB = 64;
// When --stream-diff is set the user has opted into the 100 MB upload branch;
// give git enough headroom to actually produce a diff that size before the
// server cap fires. The env override always wins so power users keep control.
const STREAM_DIFF_DEFAULT_GIT_MAX_BUFFER_MB = 110;

export function resolveGitMaxBufferBytes(
  env: Record<string, string | undefined> = process.env,
  defaultMb: number = DEFAULT_GIT_MAX_BUFFER_MB,
): number {
  const parsed = Number.parseInt(env.CLI_GIT_MAX_BUFFER_MB ?? "", 10);
  const maxBufferMb =
    Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMb;
  return maxBufferMb * 1024 * 1024;
}

function resolvePositiveIntArg(
  flagName: string,
  rawValue: string | null,
  defaultValue: number,
): number {
  if (!rawValue) return defaultValue;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Error: ${flagName} must be a positive integer`);
    process.exit(1);
  }
  return parsed;
}

function printUsage(): void {
  console.log(`
Usage: npm run cli -- [options]

Options:
  --server-url <url>   Server endpoint (or env SERVER_URL)
  --api-key <key>      Bearer token (or env API_SECRET_KEY)
  --script-only        Skip video generation, return script only
  --tts-only           Stop after TTS synthesis, return script + audio files
  --deepdive           Enable reviewer-style deepdive narration
  --short-dur          Generate a short video (20–60 seconds)
  --popcorn          Generate a popcorn video (~5 minutes, extended depth)
  --output <path>      Write result JSON to file (default: stdout)
  --uncommitted        Use 'git diff HEAD' instead of 'git diff HEAD~1..HEAD'
  --pr-number <n>      PR number (default: 1)
  --title <text>       PR title (default: last commit message)
  --diff-file <path>   Use a local unified-diff file instead of git (mutually exclusive with --pr-number, --title, --uncommitted, --retry-job, --stream-diff)
  --stream-diff        (default) Stream the git diff via the 100 MB upload branch. Mutually exclusive with --diff-file, --retry-job, --pr-number.
  --no-stream-diff     Use the legacy JSON branch (5 MB cap) instead of streaming. Required to send --pr-number with real metadata.
  --retry-job <id>     Retry a failed job by ID (skips job creation)
  --max-polls <n>      Max polling attempts (or env CLI_MAX_POLLS, default: unlimited)
  --poll-interval-ms <n> Poll interval in ms (or env CLI_POLL_INTERVAL_MS, default: 5000)
  --help               Show this help message
`);
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  if (args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  const getFlag = (name: string): boolean => args.includes(name);
  const getValue = (name: string): string | null => {
    const idx = args.indexOf(name);
    if (idx === -1 || idx + 1 >= args.length) return null;
    return args[idx + 1];
  };

  const serverUrl =
    getValue("--server-url") ?? process.env.SERVER_URL ?? "";
  const apiKey =
    getValue("--api-key") ?? process.env.API_SECRET_KEY ?? "";
  if (!serverUrl) {
    console.error("Error: --server-url or SERVER_URL env is required");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("Error: --api-key or API_SECRET_KEY env is required");
    process.exit(1);
  }

  const prNumber = resolvePositiveIntArg(
    "--pr-number",
    getValue("--pr-number"),
    1,
  );

  const maxPollsRaw = getValue("--max-polls") ?? process.env.CLI_MAX_POLLS ?? null;
  const maxPolls: number | null = maxPollsRaw
    ? resolvePositiveIntArg("--max-polls / CLI_MAX_POLLS", maxPollsRaw, 0)
    : null;
  const pollIntervalMs = resolvePositiveIntArg(
    "--poll-interval-ms / CLI_POLL_INTERVAL_MS",
    getValue("--poll-interval-ms") ?? process.env.CLI_POLL_INTERVAL_MS ?? null,
    5_000,
  );

  const scriptOnly = getFlag("--script-only");
  const ttsOnly = getFlag("--tts-only");
  const deepdive = getFlag("--deepdive");
  const shortDur = getFlag("--short-dur");
  const popcorn = getFlag("--popcorn");
  if (scriptOnly && ttsOnly) {
    console.error("Error: --script-only and --tts-only are mutually exclusive");
    process.exit(1);
  }
  if (shortDur && popcorn) {
    console.error("Error: --short-dur and --popcorn are mutually exclusive");
    process.exit(1);
  }

  // --stream-diff is now the default. Forms accepted (mirroring Go's
  // cobra/pflag bool parsing):
  //   --stream-diff           → explicit-on
  //   --stream-diff=true|1    → explicit-on
  //   --stream-diff=false|0   → explicit-off (equivalent to --no-stream-diff)
  //   --no-stream-diff        → explicit-off
  // Any other --stream-diff=X is rejected as malformed.
  let streamDiffExplicit = false;
  let streamDiffValue: boolean | null = null;
  for (const a of args) {
    if (a === "--stream-diff") {
      streamDiffExplicit = true;
      streamDiffValue = true;
    } else if (a.startsWith("--stream-diff=")) {
      const v = a.slice("--stream-diff=".length).toLowerCase();
      if (v === "true" || v === "1") {
        streamDiffExplicit = true;
        streamDiffValue = true;
      } else if (v === "false" || v === "0") {
        streamDiffExplicit = true;
        streamDiffValue = false;
      } else {
        console.error(`Error: --stream-diff=${v} is not a valid boolean (use true or false)`);
        process.exit(2);
      }
    }
  }
  const noStreamDiff = args.includes("--no-stream-diff");
  if (streamDiffValue === true && noStreamDiff) {
    console.error("Error: --stream-diff and --no-stream-diff are mutually exclusive");
    process.exit(2);
  }
  // Resolve to the effective boolean. Default is true. --no-stream-diff or
  // --stream-diff=false both flip it off.
  const streamDiff = noStreamDiff ? false : streamDiffValue !== false;

  const diffFileRaw = getValue("--diff-file");
  let diffFile: string | null = null;
  if (diffFileRaw) {
    // Mutual exclusion checks (exit code 2). `--stream-diff` only conflicts
    // here when the user passed it *explicitly* — the default-true value is
    // overridden by being in --diff-file mode.
    const mutuallyExclusive: [boolean, string][] = [
      [getFlag("--pr-number") || args.includes("--pr-number"), "--pr-number"],
      [getValue("--title") !== null, "--title"],
      [getFlag("--uncommitted"), "--uncommitted"],
      [getValue("--retry-job") !== null, "--retry-job"],
      // Only flag when the user explicitly asked for streaming ON; the
      // explicit-off form (--stream-diff=false) is functionally identical
      // to --no-stream-diff and should not collide with --diff-file mode.
      [streamDiffExplicit && streamDiff, "--stream-diff"],
    ];
    for (const [present, flag] of mutuallyExclusive) {
      if (present) {
        console.error(`Error: --diff-file is mutually exclusive with ${flag}`);
        process.exit(2);
      }
    }

    const resolved = resolvePath(process.cwd(), diffFileRaw);

    // Pre-flight: file exists and is non-empty (exit code 3)
    let fileSize: number;
    try {
      const stat = statSync(resolved);
      fileSize = stat.size;
    } catch {
      console.error(`Error: diff file not found: ${resolved}`);
      process.exit(3);
    }
    if (fileSize === 0) {
      console.error("Error: diff file is empty");
      process.exit(3);
    }

    // Pre-flight: looks like a unified diff (exit code 4)
    const HEADER_BYTES = 4096;
    const buf = Buffer.alloc(Math.min(HEADER_BYTES, fileSize));
    const fd = openSync(resolved, "r");
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const header = buf.toString("utf8", 0, buf.length);
    const firstLine = header.split("\n")[0] ?? "";
    if (!firstLine.startsWith("diff --git ")) {
      console.error("Error: file does not appear to be a unified git diff (must start with 'diff --git')");
      process.exit(4);
    }

    diffFile = resolved;
  }

  // Explicit `--stream-diff=true` cannot coexist with --retry-job (different
  // action). `--stream-diff=false` is the opt-out path and does not conflict;
  // the --diff-file case is already covered by the mutex block above.
  if (streamDiffExplicit && streamDiff && getValue("--retry-job") !== null) {
    console.error("Error: --stream-diff is mutually exclusive with --retry-job");
    process.exit(2);
  }

  // If streaming will actually be the upload path (i.e. normal git-source
  // mode and streamDiff active), --pr-number is silently ignored by the
  // server. Fail fast with a clear migration hint instead of letting the
  // user's PR number disappear into the synthetic prNumber=1 default.
  const inNormalMode =
    diffFileRaw === null && getValue("--retry-job") === null;
  const prNumberExplicit =
    getValue("--pr-number") !== null ||
    args.some((a) => a === "--pr-number" || a.startsWith("--pr-number="));
  if (streamDiff && inNormalMode && prNumberExplicit) {
    console.error(
      "Error: --pr-number is not honored in streaming mode (the default). " +
        "Pass --no-stream-diff to send the PR number via the legacy JSON branch.",
    );
    process.exit(2);
  }

  return {
    serverUrl: serverUrl.replace(/\/$/, ""),
    apiKey,
    scriptOnly,
    ttsOnly,
    deepdive,
    shortDur,
    popcorn,
    output: getValue("--output"),
    uncommitted: getFlag("--uncommitted"),
    prNumber,
    title: getValue("--title"),
    retryJob: getValue("--retry-job"),
    maxPolls,
    pollIntervalMs,
    diffFile,
    streamDiff,
  };
}

// --- Git helpers ---

function gitExec(args: string[], defaultMb: number = DEFAULT_GIT_MAX_BUFFER_MB): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      maxBuffer: resolveGitMaxBufferBytes(process.env, defaultMb),
    }).trim();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOBUFS"
    ) {
      const maxBufferMb = resolveGitMaxBufferBytes(process.env, defaultMb) / (1024 * 1024);
      console.error(
        `Error: git ${args.join(" ")} output exceeded buffer (${maxBufferMb}MB). ` +
          "Increase CLI_GIT_MAX_BUFFER_MB and try again.",
      );
      process.exit(1);
    }
    throw error;
  }
}

export function parseRepoFullName(remoteUrl: string): string {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(
    /\/([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch) return httpsMatch[1];

  throw new Error(`Cannot parse repo from remote URL: ${remoteUrl}`);
}

function gatherGitInfo(args: CliArgs): {
  diff: string;
  repoFullName: string;
  headBranch: string;
  title: string;
} {
  const diffArgs = args.uncommitted
    ? ["diff", "HEAD"]
    : ["diff", "HEAD~1..HEAD"];
  // --stream-diff opts the user into the 100 MB server branch; size the local
  // git buffer to match by default (overridable via CLI_GIT_MAX_BUFFER_MB).
  const diffDefaultMb = args.streamDiff
    ? STREAM_DIFF_DEFAULT_GIT_MAX_BUFFER_MB
    : DEFAULT_GIT_MAX_BUFFER_MB;
  const diff = gitExec(diffArgs, diffDefaultMb);

  if (!diff) {
    console.error("Error: git diff returned empty output. Nothing to process.");
    process.exit(1);
  }

  const remoteUrl = gitExec(["remote", "get-url", "origin"]);
  const repoFullName = parseRepoFullName(remoteUrl);
  const headBranch = gitExec(["branch", "--show-current"]);
  const title = args.title ?? gitExec(["log", "-1", "--pretty=%s"]);

  return { diff, repoFullName, headBranch, title };
}

// --- API client ---

interface JobResponse {
  id: string;
  status: string;
  videoUrl: string | null;
  scriptJson: unknown;
  ttsAudioJson: unknown;
  errorCode?: string | null;
  errorMessage: string | null;
}

interface CreateJobPayloadInput {
  prNumber: number;
  scriptOnly: boolean;
  ttsOnly: boolean;
  deepdive: boolean;
  durationMode: "default" | "short" | "popcorn";
}

interface GitSnapshot {
  diff: string;
  repoFullName: string;
  headBranch: string;
  title: string;
}

export function buildCreateJobPayload(
  args: CreateJobPayloadInput,
  git: GitSnapshot,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    repoFullName: git.repoFullName,
    prNumber: args.prNumber,
    prTitle: git.title,
    prDescription: "",
    diff: git.diff,
    baseBranch: "main",
    headBranch: git.headBranch,
    issues: [],
    milestone: null,
    isPrivate: false,
    scriptOnly: args.scriptOnly,
    ttsOnly: args.ttsOnly,
    deepdive: args.deepdive,
    durationMode: args.durationMode,
  };

  return payload;
}

/**
 * APIError carries the server's structured `{error, message}` shape when the
 * response is a non-2xx. The errorCode lets callers map e.g. a create-time 413
 * DIFF_TOO_LARGE to exit code 5, matching the polling-time contract.
 */
export class APIError extends Error {
  readonly label: string;
  readonly status: number;
  readonly errorCode: string | null;
  constructor(label: string, status: number, errorCode: string | null, detail: string) {
    super(`${label} failed (${status}): ${detail}`);
    this.name = "APIError";
    this.label = label;
    this.status = status;
    this.errorCode = errorCode;
  }
}

/** Shared fetch wrapper: throws APIError on non-2xx with a descriptive message. */
async function apiFetch(
  url: string,
  label: string,
  init: RequestInit,
): Promise<JobResponse> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    const detail = body.trim() || res.statusText || "<empty response body>";
    // Best-effort: extract the standardized `error` field so callers can map
    // it to the documented exit codes.
    let errorCode: string | null = null;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.error === "string") {
        errorCode = parsed.error;
      }
    } catch {
      /* response wasn't JSON; that's fine */
    }
    throw new APIError(label, res.status, errorCode, detail);
  }
  return res.json() as Promise<JobResponse>;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function createJob(
  serverUrl: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<JobResponse> {
  return apiFetch(`${serverUrl}/api/jobs`, "POST /api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify(payload),
  });
}

/**
 * Maps a server-reported job error code to the CLI process exit code,
 * defaulting to 1 for unmapped or missing codes. Exported so tests can pin the
 * `--diff-file` / `--stream-diff` / normal-mode contract.
 */
export function mapDiffExitCode(errorCode: string | null | undefined): number {
  const DIFF_EXIT_CODES: Record<string, number> = {
    DIFF_TOO_LARGE: 5,
    DIFF_PARSE_ERROR: 6,
    DIFF_FETCH_TIMEOUT: 7,
  };
  return DIFF_EXIT_CODES[errorCode ?? ""] ?? 1;
}

/**
 * Submits a job via the `application/x-git-diff` streaming branch (100 MB cap)
 * using a diff already buffered in memory. Used by `--stream-diff` so users
 * with large diffs don't have to write to a file first.
 */
export async function createJobFromDiffStream(
  serverUrl: string,
  apiKey: string,
  diff: Buffer,
  query: URLSearchParams,
): Promise<JobResponse> {
  return apiFetch(
    `${serverUrl}/api/jobs?${query.toString()}`,
    "POST /api/jobs (stream-diff)",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-diff",
        "X-Diff-Source": "local-stream",
        "Content-Length": String(diff.byteLength),
        ...authHeaders(apiKey),
      },
      body: Readable.from([diff]) as unknown as BodyInit,
      duplex: "half",
    } as unknown as RequestInit,
  );
}

async function pollJob(
  serverUrl: string,
  apiKey: string,
  jobId: string,
): Promise<JobResponse> {
  return apiFetch(
    `${serverUrl}/api/jobs/${jobId}`,
    `GET /api/jobs/${jobId}`,
    { headers: authHeaders(apiKey) },
  );
}

async function retryJob(
  serverUrl: string,
  apiKey: string,
  jobId: string,
): Promise<JobResponse> {
  return apiFetch(
    `${serverUrl}/api/jobs/${jobId}/retry`,
    `POST /api/jobs/${jobId}/retry`,
    { method: "POST", headers: authHeaders(apiKey) },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}

/** Polls a job until it reaches a terminal state or the poll budget is exhausted. */
async function awaitTerminal(
  serverUrl: string,
  apiKey: string,
  jobId: string,
  initial: JobResponse,
  maxPolls: number | null,
  pollIntervalMs: number,
): Promise<JobResponse> {
  let current = initial;
  for (let i = 0; maxPolls === null || i < maxPolls; i++) {
    if (isTerminal(current.status)) break;
    await sleep(pollIntervalMs);
    current = await pollJob(serverUrl, apiKey, jobId);
    console.log(`  Poll ${i + 1}: status=${current.status}`);
  }
  return current;
}

// --- Readable TTS output ---

interface ReadableScript {
  changeType?: string;
  summary?: string;
  totalDurationSeconds?: number;
  totalWordCount?: number;
  scenes?: Array<{
    sceneNumber: number;
    sceneType: string;
    durationSeconds: number;
    narration: string;
  }>;
}

interface ReadableTTSAudio {
  sceneNumber: number;
  wordTimings?: Array<{ word: string; startTimeMs: number; endTimeMs: number }>;
  clipDurations?: number[];
  audioUrl?: string;
}

export function formatTTSReadable(
  scriptJson: Record<string, unknown>,
  ttsAudio: Array<Record<string, unknown>>,
): string {
  const script = scriptJson as ReadableScript;
  const lines: string[] = [];

  lines.push("═".repeat(55));
  lines.push("PR VIDEO SCRIPT — TTS Preview");
  lines.push("═".repeat(55));
  lines.push(`Change type: ${script.changeType ?? "unknown"}`);
  lines.push(`Summary: ${script.summary ?? ""}`);
  const sceneCount = script.scenes?.length ?? 0;
  lines.push(
    `Total duration: ${script.totalDurationSeconds ?? 0}s | ` +
    `Word count: ${script.totalWordCount ?? 0} | Scenes: ${sceneCount}`,
  );

  const audioByScene = new Map<number, ReadableTTSAudio>(
    (ttsAudio as unknown as ReadableTTSAudio[]).map((a) => [a.sceneNumber, a]),
  );

  for (const scene of script.scenes ?? []) {
    lines.push("");
    lines.push("─".repeat(55));
    lines.push(`Scene ${scene.sceneNumber} — ${scene.sceneType} (${scene.durationSeconds}s)`);
    lines.push("─".repeat(55));

    lines.push("Narration:");
    for (const line of scene.narration.split("\n")) {
      lines.push(`  ${line}`);
    }

    const audio = audioByScene.get(scene.sceneNumber);
    if (audio?.wordTimings?.length) {
      lines.push("");
      lines.push("Word timings:");
      for (const wt of audio.wordTimings) {
        const start = (wt.startTimeMs / 1000).toFixed(3);
        const end = (wt.endTimeMs / 1000).toFixed(3);
        lines.push(`  [${start}s – ${end}s] ${wt.word}`);
      }
    }

    if (audio?.clipDurations?.length) {
      lines.push("");
      lines.push(`Clip durations: ${audio.clipDurations.map((d) => `${d}s`).join(" + ")}`);
    }

    if (audio?.audioUrl) {
      lines.push(`Audio URL: ${audio.audioUrl}`);
    } else {
      lines.push("Audio: (no audio)");
    }
  }

  lines.push("");
  return lines.join("\n");
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // --- Retry mode ---
  if (args.retryJob) {
    console.log(`Retrying job: ${args.retryJob}`);
    console.log(`Server:       ${args.serverUrl}`);
    console.log();

    const retryResult = await retryJob(args.serverUrl, args.apiKey, args.retryJob);
    console.log(`Retry initiated: ${JSON.stringify(retryResult)}`);

    const current = await awaitTerminal(
      args.serverUrl, args.apiKey, args.retryJob,
      retryResult, args.maxPolls, args.pollIntervalMs,
    );

    if (current.status === "failed") {
      console.error(`\nRetry failed: ${current.errorMessage}`);
      process.exit(1);
    }
    if (current.status === "completed") {
      console.log(`\nRetry succeeded! Video URL: ${current.videoUrl}`);
    } else {
      console.error(`\nRetry did not complete in time (status: ${current.status})`);
      process.exit(1);
    }
    return;
  }

  // --- Diff-file mode ---
  if (args.diffFile) {
    const today = new Date().toISOString().slice(0, 10);
    const autoTitle = `${today}-git-diff`;
    console.log(`Diff file:   ${args.diffFile}`);
    console.log(`PR Title:    ${autoTitle}`);
    console.log(`Script Only: ${args.scriptOnly}`);
    console.log(`Server:      ${args.serverUrl}`);
    console.log();

    const searchParams = new URLSearchParams({
      scriptOnly: String(args.scriptOnly),
      ttsOnly: String(args.ttsOnly),
      deepdive: String(args.deepdive),
      durationMode: args.popcorn ? "popcorn" : args.shortDur ? "short" : "default",
      prTitle: autoTitle,
    });

    const diffJob = await apiFetch(
      `${args.serverUrl}/api/jobs?${searchParams.toString()}`,
      "POST /api/jobs (diff-file)",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-diff",
          "X-Diff-Source": "local-file",
          ...authHeaders(args.apiKey),
        },
        body: createReadStream(args.diffFile) as unknown as BodyInit,
        duplex: "half",
      } as unknown as RequestInit,
    );

    console.log(`Job created: ${diffJob.id} (status: ${diffJob.status})`);
    const diffCurrent = await awaitTerminal(
      args.serverUrl, args.apiKey, diffJob.id,
      diffJob, args.maxPolls, args.pollIntervalMs,
    );

    if (diffCurrent.status === "failed") {
      const code = diffCurrent.errorCode ? ` (${diffCurrent.errorCode})` : "";
      console.error(`\nJob failed${code}: ${diffCurrent.errorMessage}`);
      process.exit(mapDiffExitCode(diffCurrent.errorCode));
    }
    if (diffCurrent.status !== "completed") {
      console.error(`\nJob did not complete in time (status: ${diffCurrent.status})`);
      process.exit(1);
    }

    if (args.output) {
      writeFileSync(args.output, JSON.stringify(diffCurrent, null, 2));
      console.log(`\nResult written to: ${args.output}`);
    } else {
      console.log(JSON.stringify(diffCurrent, null, 2));
    }
    return;
  }

  // --- Normal / --stream-diff mode ---
  // Both gather the diff via git and render the same header lines. They
  // differ only on the wire: normal mode embeds the diff in JSON (5 MB cap);
  // --stream-diff streams it via application/x-git-diff (100 MB cap).
  const git = gatherGitInfo(args);

  console.log(`Repo:        ${git.repoFullName}`);
  console.log(`Branch:      ${git.headBranch}`);
  console.log(`PR Title:    ${git.title}`);
  console.log(`Script Only: ${args.scriptOnly}`);
  console.log(`TTS Only:    ${args.ttsOnly}`);
  console.log(`Deepdive:    ${args.deepdive}`);
  console.log(`Duration:    ${args.popcorn ? "popcorn (~5 min)" : args.shortDur ? "short (20–60s)" : "default"}`);
  console.log(`Server:      ${args.serverUrl}`);
  console.log();

  const durationMode = args.popcorn ? "popcorn" : args.shortDur ? "short" : "default";

  let job: JobResponse;
  if (args.streamDiff) {
    const query = new URLSearchParams({
      scriptOnly: String(args.scriptOnly),
      ttsOnly: String(args.ttsOnly),
      deepdive: String(args.deepdive),
      durationMode,
      prTitle: git.title,
    });
    console.log("Creating job (streaming diff)...");
    job = await createJobFromDiffStream(
      args.serverUrl,
      args.apiKey,
      Buffer.from(git.diff, "utf-8"),
      query,
    );
  } else {
    const payload = buildCreateJobPayload(
      {
        prNumber: args.prNumber,
        scriptOnly: args.scriptOnly,
        ttsOnly: args.ttsOnly,
        deepdive: args.deepdive,
        durationMode,
      },
      git,
    );
    console.log("Creating job...");
    job = await createJob(args.serverUrl, args.apiKey, payload);
  }
  console.log(`Job created: ${job.id} (status: ${job.status})`);
  const current = await awaitTerminal(
    args.serverUrl, args.apiKey, job.id,
    job, args.maxPolls, args.pollIntervalMs,
  );

  if (current.status === "failed") {
    const code = current.errorCode ? ` (${current.errorCode})` : "";
    console.error(`\nJob failed${code}: ${current.errorMessage}`);
    // Map server-side diff errors to the same exit codes as --diff-file so
    // CI tooling sees a consistent contract regardless of upload path.
    process.exit(mapDiffExitCode(current.errorCode));
  }

  if (current.status !== "completed") {
    console.error(`\nJob did not complete in time (status: ${current.status})`);
    process.exit(1);
  }

  // Output result
  if (args.scriptOnly) {
    const output = JSON.stringify(current.scriptJson, null, 2);
    if (args.output) {
      writeFileSync(args.output, output, "utf-8");
      console.log(`\nScript written to ${args.output}`);
    } else {
      console.log("\n--- Script JSON ---");
      console.log(output);
    }
  } else if (args.ttsOnly) {
    const scriptJson = current.scriptJson as Record<string, unknown>;
    const ttsAudio = (current.ttsAudioJson ?? []) as Array<Record<string, unknown>>;
    const readable = formatTTSReadable(scriptJson, ttsAudio);

    if (args.output) {
      const jsonOutput = JSON.stringify({ scriptJson, ttsAudio }, null, 2);
      writeFileSync(args.output, jsonOutput, "utf-8");
      const txtPath = args.output.replace(/\.[^.]+$/, ".txt");
      writeFileSync(txtPath, readable, "utf-8");
      console.log(`\nTTS JSON written to ${args.output}`);
      console.log(`Readable script written to ${txtPath}`);
    } else {
      console.log(readable);
    }
  } else {
    console.log(`\nVideo URL: ${current.videoUrl}`);
    if (args.output) {
      const output = JSON.stringify(
        { videoUrl: current.videoUrl, scriptJson: current.scriptJson },
        null,
        2,
      );
      writeFileSync(args.output, output, "utf-8");
      console.log(`Result written to ${args.output}`);
    }
  }
}

// Only run when executed directly (not when imported for testing)
const isDirectRun =
  process.argv[1]?.endsWith("local-test.ts") ||
  process.argv[1]?.endsWith("local-test.js");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    // Map server-side diff errors that surface at create time (e.g. a 413
    // DIFF_TOO_LARGE from POST /api/jobs) to the same exit codes the polling
    // path uses for terminal failures, matching the README contract.
    if (err instanceof APIError) {
      process.exit(mapDiffExitCode(err.errorCode));
    }
    process.exit(1);
  });
}
