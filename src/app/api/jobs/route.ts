import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prContextSchema, durationModeEnum } from "@/domain/entities/PRContext";
import type { VideoJob } from "@/domain/entities/VideoJob";
import { withJobsAuth } from "@/lib/apiMiddleware";
import { createPipelineRunner } from "@/app/api/pipelineFactory";
import { serializeJobResponse } from "@/app/api/jobResponse";

const DIFF_UPLOAD_SIZE_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MB

type RequestedJobMode = "video" | "script_only" | "tts_only";

function resolveRequestedJobMode(args: {
  scriptOnly: boolean;
  ttsOnly: boolean;
}): RequestedJobMode {
  if (args.ttsOnly) return "tts_only";
  if (args.scriptOnly) return "script_only";
  return "video";
}

function buildActiveJobConflictMessage(args: {
  requestedMode: RequestedJobMode;
}): string {
  if (args.requestedMode === "tts_only") {
    return "An active job for this PR is already processing. Wait for it to complete before requesting a TTS preview.";
  }

  return "An active job for this PR is already processing. Wait for it to complete.";
}

export const POST = withJobsAuth(async (request, { container, auth, logger }) => {
  logger.info("POST /api/jobs received");

  const contentType = request.headers.get("content-type") ?? "";

  // --- application/x-git-diff branch (local diff file upload) ---
  if (contentType.startsWith("application/x-git-diff")) {
    const url = new URL(request.url);
    const qScriptOnly = url.searchParams.get("scriptOnly") === "true";
    const qTtsOnly = url.searchParams.get("ttsOnly") === "true";
    const qDeepdive = url.searchParams.get("deepdive") === "true";
    const rawDurationMode = url.searchParams.get("durationMode") ?? "default";
    const prTitle = url.searchParams.get("prTitle") ?? `${new Date().toISOString().slice(0, 10)}-git-diff`;

    if (qScriptOnly && qTtsOnly) {
      return NextResponse.json(
        { error: "BAD_REQUEST", message: "scriptOnly and ttsOnly are mutually exclusive" },
        { status: 400 },
      );
    }

    // Validate query-derived fields BEFORE opening the file descriptor. If we
    // deferred this to prContextSchema.parse() (after the upload completed), an
    // invalid durationMode/prTitle would orphan the temp file and let the caller
    // accumulate them by repeating the request without the one-time key being claimed.
    const durationModeParse = durationModeEnum.safeParse(rawDurationMode);
    if (!durationModeParse.success) {
      return NextResponse.json(
        {
          error: "BAD_REQUEST",
          message: `Invalid durationMode "${rawDurationMode}". Must be one of: default, short, popcorn`,
        },
        { status: 400 },
      );
    }
    const qDurationMode = durationModeParse.data;
    if (prTitle.length > 500) {
      return NextResponse.json(
        { error: "BAD_REQUEST", message: "prTitle exceeds 500 characters" },
        { status: 400 },
      );
    }

    // Validate body before opening any file descriptor so an empty-body request
    // doesn't leak a zero-byte temp file and an open writeStream FD on the early return.
    const bodyStream = request.body;
    if (!bodyStream) {
      return NextResponse.json({ error: "BAD_REQUEST", message: "Empty body" }, { status: 400 });
    }

    const tempPath = path.join(os.tmpdir(), `prvod-diff-${randomUUID()}.diff`);
    const writeStream = createWriteStream(tempPath, { mode: 0o600 });

    // Hoisted out of the try block so we can post-check after pipeline completes.
    let bytesWritten = 0;
    try {
      // Stream request body to temp file with 100 MB size cap.
      // Uses pipeline() so backpressure is respected and writeStream's
      // "finish"/"close" event is awaited — without this, the pipeline could
      // start parsing the temp file before the write was flushed to disk.
      const sizeCapTransform = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytesWritten += chunk.length;
          if (bytesWritten > DIFF_UPLOAD_SIZE_LIMIT_BYTES) {
            cb(new Error("DIFF_TOO_LARGE"));
            return;
          }
          cb(null, chunk);
        },
      });

      const nodeStream = Readable.fromWeb(bodyStream as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeStream, sizeCapTransform, writeStream);
    } catch (uploadErr) {
      await fs.unlink(tempPath).catch(() => undefined);
      const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
      if (msg === "DIFF_TOO_LARGE") {
        return NextResponse.json({ error: "DIFF_TOO_LARGE", message: "Diff file exceeds 100 MB limit" }, { status: 413 });
      }
      logger.error("Diff file upload failed", { error: msg });
      return NextResponse.json({ error: "UPLOAD_FAILED", message: "Failed to receive diff file" }, { status: 500 });
    }

    // Reject zero-byte uploads. request.body is non-null even for empty bodies,
    // so the upstream null check doesn't catch this case. Without this, an empty
    // upload consumes a one-time key and produces an empty/garbage analysis.
    if (bytesWritten === 0) {
      await fs.unlink(tempPath).catch(() => undefined);
      logger.warn("Rejecting zero-byte diff upload", { keyId: auth.keyId });
      return NextResponse.json(
        { error: "BAD_REQUEST", message: "Empty diff upload — request body contained no bytes" },
        { status: 400 },
      );
    }

    // Build synthetic PRContext for local diff. Wrap the parse so any unexpected
    // schema rejection unlinks the just-uploaded tempPath (defense-in-depth — query
    // fields above are pre-validated, but synthetic fields could still drift).
    const jobId = randomUUID();
    const syntheticRepoFullName = `local/diff-${jobId.slice(0, 8)}`;
    let prContext;
    try {
      prContext = prContextSchema.parse({
        repoFullName: syntheticRepoFullName,
        prNumber: 1,
        prTitle,
        prDescription: "",
        diffSource: { kind: "local_diff_file", tempPath },
        customDiffTitle: /^\d{4}-\d{2}-\d{2}-git-diff$/.test(prTitle) ? prTitle : undefined,
        baseBranch: "",
        headBranch: "",
        issues: [],
        milestone: null,
        isPrivate: false,
        durationMode: qDurationMode,
        deepdive: qDeepdive,
      });
    } catch (parseErr) {
      await fs.unlink(tempPath).catch(() => undefined);
      logger.warn("Diff-file synthetic PRContext failed schema validation", {
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
      return NextResponse.json(
        { error: "BAD_REQUEST", message: "Invalid request parameters" },
        { status: 400 },
      );
    }

    const durationMode = prContext.durationMode ?? "default";
    const isOneTimeKey = auth.maxUses !== null;
    let diffJob: VideoJob;
    try {
      diffJob = await container.jobRepository.create({
        repoFullName: prContext.repoFullName,
        prNumber: prContext.prNumber,
        repoIsPrivate: false,
        installationRef: null,
        triggeredVia: "api",
        // Attach apiKeyId so the GET /api/jobs/:id read route accepts polling
        // from the same one-time key (it rejects when job.apiKeyId !== auth.keyId).
        ...(isOneTimeKey ? { apiKeyId: auth.keyId } : {}),
        ...(durationMode !== "default" || prContext.deepdive
          ? { metricsJson: { ...(durationMode !== "default" ? { durationMode } : {}), ...(prContext.deepdive ? { deepdive: true } : {}) } }
          : {}),
      });
    } catch (createErr) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw createErr;
    }

    logger.info("Diff-file job created", { jobId: diffJob.id, durationMode });
    if (isOneTimeKey) {
      const claimed = await container.apiKeyRepository.claimForJob(auth.keyId, diffJob.id);
      if (!claimed) {
        await container.jobRepository.deleteById(diffJob.id).catch(() => undefined);
        await fs.unlink(tempPath).catch(() => undefined);
        return NextResponse.json(
          { error: "KEY_IN_USE", message: "A job is already in progress for this key" },
          { status: 429 },
        );
      }
    }

    const diffRunner = createPipelineRunner(container, { apiKeyRepository: isOneTimeKey, githubService: false, diffSource: true });
    diffRunner.run(diffJob.id, prContext, { scriptOnly: qScriptOnly, ttsOnly: qTtsOnly, apiKeyId: isOneTimeKey ? auth.keyId : undefined })
      .catch((e) => {
        logger.error("Diff-file pipeline runner error", { error: e instanceof Error ? e.message : "Unknown" });
      });

    return NextResponse.json(serializeJobResponse(diffJob), { status: 201 });
  }

  // --- JSON branch (legacy / GitHub webhook path) ---

  // Parse and validate body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Extract scriptOnly/ttsOnly before Zod parsing (not part of PRContext schema)
  const rawBody = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const scriptOnly = rawBody.scriptOnly === true;
  const ttsOnly = rawBody.ttsOnly === true;
  const requestedMode = resolveRequestedJobMode({ scriptOnly, ttsOnly });
  if (scriptOnly && ttsOnly) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "scriptOnly and ttsOnly are mutually exclusive" },
      { status: 400 },
    );
  }

  // Security: reject any caller-supplied diffSource on the JSON branch.
  // A client could otherwise submit { kind: "local_diff_file", tempPath: "/etc/passwd" }
  // and have the runner open arbitrary filesystem paths via LocalFileDiffSource, or
  // { kind: "github_pr", installationId: ... } to fetch private repos with the
  // server's GitHub App token. The only legitimate JSON-input shape is the legacy
  // `diff: string`, which we convert to a server-controlled tempPath below.
  if (rawBody.diffSource !== undefined) {
    logger.warn("Rejecting caller-supplied diffSource on /api/jobs JSON branch", {
      keyId: auth.keyId,
      kind: typeof rawBody.diffSource === "object" && rawBody.diffSource !== null
        ? (rawBody.diffSource as { kind?: unknown }).kind
        : typeof rawBody.diffSource,
    });
    return NextResponse.json(
      {
        error: "DIFF_SOURCE_NOT_ALLOWED",
        message:
          "Caller-supplied diffSource is not accepted on /api/jobs. Send `diff: string` (legacy CLI body) or upload via Content-Type: application/x-git-diff.",
      },
      { status: 403 },
    );
  }

  // Legacy compat: CLI normal path sends `diff: string` — extract content now, write file later
  // (after all validation/rate-limit/active-job checks to avoid leaking temp files on early returns)
  let legacyDiffStr: string | null = null;
  if (typeof rawBody.diff === "string") {
    // Restore the 5 MB cap previously enforced by `diff: z.string().max(5 * 1024 * 1024)`
    // on prContextSchema. After spec-005 removed the schema field, an authenticated
    // JSON client could otherwise send an unbounded string (the streaming-upload
    // path's 100 MB cap doesn't apply because we're on the JSON branch).
    const LEGACY_DIFF_MAX_BYTES = 5 * 1024 * 1024;
    const legacyDiffBytes = Buffer.byteLength(rawBody.diff, "utf8");
    if (legacyDiffBytes > LEGACY_DIFF_MAX_BYTES) {
      logger.warn("Rejecting oversized legacy diff body on /api/jobs JSON branch", {
        keyId: auth.keyId,
        bytes: legacyDiffBytes,
        limit: LEGACY_DIFF_MAX_BYTES,
      });
      return NextResponse.json(
        {
          error: "DIFF_TOO_LARGE",
          message: `Legacy diff body exceeds ${LEGACY_DIFF_MAX_BYTES} bytes. Upload via Content-Type: application/x-git-diff for diffs up to 100 MB.`,
        },
        { status: 413 },
      );
    }
    legacyDiffStr = rawBody.diff;
    rawBody.diffSource = { kind: "local_diff_file", tempPath: "" }; // placeholder so schema validation passes
  }

  const parsed = prContextSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn("Validation failed", {
      errors: parsed.error.flatten().fieldErrors,
    });
    return NextResponse.json(
      {
        error: "BAD_REQUEST",
        message: `Invalid request body: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      },
      { status: 400 },
    );
  }

  const prContext = parsed.data;

  // Defense-in-depth: caller-supplied diffSource was rejected pre-parse above,
  // so prContext.diffSource here is always the server-built local_diff_file
  // placeholder from legacyDiffStr. Anything else means the rejection above was
  // bypassed — fail closed.
  if (prContext.diffSource.kind !== "local_diff_file") {
    logger.error("Unexpected diffSource.kind reached post-validation block", {
      keyId: auth.keyId,
      kind: prContext.diffSource.kind,
    });
    return NextResponse.json(
      { error: "DIFF_SOURCE_NOT_ALLOWED", message: "Invalid diffSource configuration" },
      { status: 403 },
    );
  }

  // Rate limiting: 50/day/repo
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCount = await container.jobRepository.countRecentByRepo(
    prContext.repoFullName,
    oneDayAgo,
    null,
  );
  if (recentCount >= 50) {
    logger.warn("Rate limit exceeded", {
      repo: prContext.repoFullName,
      count: recentCount,
    });
    return NextResponse.json(
      {
        error: "RATE_LIMIT_EXCEEDED",
        message:
          "Repository has exceeded the daily video generation limit (50/day)",
      },
      { status: 429 },
    );
  }

  // One query: find any active job for this PR, then branch on durationMode match
  const isOneTimeKey = auth.maxUses !== null;
  const activeJob = await container.jobRepository.findActiveByPR(
    prContext.repoFullName,
    prContext.prNumber,
    null,
  );
  if (activeJob) {
    // Authorization scoping: one-time keys can only see/reuse their own jobs.
    const callerOwnsJob = !isOneTimeKey || activeJob.apiKeyId === auth.keyId;

    if (!callerOwnsJob) {
      // Another caller's job is active on this PR — block without leaking details.
      logger.warn("Active job from another key blocks one-time key request", {
        keyId: auth.keyId,
        existingJobId: activeJob.id,
      });
      return NextResponse.json(
        {
          error: "ACTIVE_JOB_CONFLICT",
          message: "A video generation job is already in progress for this PR",
        },
        { status: 409 },
      );
    }

    const activeJobDurationMode =
      (activeJob.metricsJson as { durationMode?: string } | null)?.durationMode ?? "default";
    const activeJobDeepdive =
      (activeJob.metricsJson as { deepdive?: boolean } | null)?.deepdive === true;
    const requestedDurationMode = prContext.durationMode ?? "default";
    const requestedDeepdive = prContext.deepdive === true;
    const durationModeMatches = activeJobDurationMode === requestedDurationMode;
    const deepdiveMatches = activeJobDeepdive === requestedDeepdive;

    if (durationModeMatches && deepdiveMatches) {
      if (requestedMode === "tts_only") {
        logger.warn("Active job blocks tts-only request", {
          existingJobId: activeJob.id,
        });
        return NextResponse.json(
          {
            error: "ACTIVE_JOB_CONFLICT",
            message: buildActiveJobConflictMessage({ requestedMode }),
            existingJobId: activeJob.id,
          },
          { status: 409 },
        );
      }

      // Idempotency: same params already active — return existing job
      logger.info("Active job already exists", { jobId: activeJob.id });
      return NextResponse.json(serializeJobResponse(activeJob), { status: 200 });
    }

    // Different durationMode or deepdive — block the request
    logger.warn("Active job with different durationMode/deepdive blocks new request", {
      existingJobId: activeJob.id,
      existingDurationMode: activeJobDurationMode,
      requestedDurationMode,
      existingDeepdive: activeJobDeepdive,
      requestedDeepdive,
    });
    return NextResponse.json(
      {
        error: "ACTIVE_JOB_CONFLICT",
        message: buildActiveJobConflictMessage({ requestedMode }),
        existingJobId: activeJob.id,
      },
      { status: 409 },
    );
  }

  // Create new job
  const durationMode = prContext.durationMode ?? "default";
  let job: VideoJob;
  try {
    job = await container.jobRepository.create({
      repoFullName: prContext.repoFullName,
      prNumber: prContext.prNumber,
      repoIsPrivate: prContext.isPrivate,
      installationRef: null,
      triggeredVia: "api",
      // Note: github_pr is rejected above; only local_diff_file reaches here.
      ...((durationMode !== "default" || prContext.deepdive)
        ? {
            metricsJson: {
              ...(durationMode !== "default" ? { durationMode } : {}),
              ...(prContext.deepdive ? { deepdive: true } : {}),
            },
          }
        : {}),
      ...(isOneTimeKey ? { apiKeyId: auth.keyId } : {}),
    });
    // create() may return an existing row from a 23505 race inside PostgresJobRepository.
    // Detect this: if apiKeyId differs from what we requested, it's someone else's job.
    const requestedApiKeyId = isOneTimeKey ? auth.keyId : null;
    const isRaceReturnedExisting = job.apiKeyId !== requestedApiKeyId;

    if (isRaceReturnedExisting && isOneTimeKey) {
      // Don't leak metadata or claim a job that belongs to another caller.
      logger.warn("Create race returned another caller's job — blocking one-time key", {
        keyId: auth.keyId, returnedJobId: job.id, returnedApiKeyId: job.apiKeyId,
      });
      return NextResponse.json(
        { error: "ACTIVE_JOB_CONFLICT", message: "A video generation job is already in progress for this PR" },
        { status: 409 },
      );
    }

    const returnedDurationMode =
      (job.metricsJson as { durationMode?: string } | null)?.durationMode ?? "default";
    const returnedDeepdive =
      (job.metricsJson as { deepdive?: boolean } | null)?.deepdive === true;
    if (
      isRaceReturnedExisting ||
      returnedDurationMode !== durationMode ||
      returnedDeepdive !== prContext.deepdive
    ) {
      if (
        returnedDurationMode !== durationMode ||
        returnedDeepdive !== prContext.deepdive
      ) {
        logger.warn("Create returned active job with different durationMode/deepdive", {
          returnedJobId: job.id,
          returnedDurationMode,
          requestedDurationMode: durationMode,
          returnedDeepdive,
          requestedDeepdive: prContext.deepdive,
        });
      }
      if (
        returnedDurationMode === durationMode &&
        returnedDeepdive === prContext.deepdive
      ) {
        logger.info("Create race returned existing job (idempotent)", { jobId: job.id });
        return NextResponse.json(serializeJobResponse(job), { status: 200 });
      }
      return NextResponse.json(
        {
          error: "ACTIVE_JOB_CONFLICT",
          message: buildActiveJobConflictMessage({ requestedMode }),
          existingJobId: job.id,
        },
        { status: 409 },
      );
    }
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      const racedJob = await container.jobRepository.findActiveByPR(
        prContext.repoFullName,
        prContext.prNumber,
        null,
      );
      if (racedJob) {
        // Ownership check: one-time keys must not see another caller's raced job.
        const racedCallerOwns = !isOneTimeKey || racedJob.apiKeyId === auth.keyId;
        if (!racedCallerOwns) {
          logger.warn("23505 race: another caller's job blocks one-time key", {
            keyId: auth.keyId, racedJobId: racedJob.id,
          });
          return NextResponse.json(
            { error: "ACTIVE_JOB_CONFLICT", message: "A video generation job is already in progress for this PR" },
            { status: 409 },
          );
        }

        const racedDurationMode =
          (racedJob.metricsJson as { durationMode?: string } | null)?.durationMode ?? "default";
        const racedDeepdive =
          (racedJob.metricsJson as { deepdive?: boolean } | null)?.deepdive === true;
        const reqDurationMode = prContext.durationMode ?? "default";
        if (
          racedDurationMode !== reqDurationMode ||
          racedDeepdive !== prContext.deepdive
        ) {
          logger.warn("Raced active job has different durationMode/deepdive", {
            racedJobId: racedJob.id,
            racedDurationMode,
            requestedDurationMode: reqDurationMode,
            racedDeepdive,
            requestedDeepdive: prContext.deepdive,
          });
          return NextResponse.json(
            {
              error: "ACTIVE_JOB_CONFLICT",
              message: buildActiveJobConflictMessage({ requestedMode }),
              existingJobId: racedJob.id,
            },
            { status: 409 },
          );
        }
        logger.info("Active job won create race", { jobId: racedJob.id });
        return NextResponse.json(serializeJobResponse(racedJob), { status: 200 });
      }
    }
    throw error;
  }
  logger.info("Job created", { jobId: job.id, durationMode });

  // Claim one-time key for ALL job types to prevent concurrent use and unlimited previews.
  // Consumption only happens on full video success (handled in PipelineRunner).
  // Preview (scriptOnly/ttsOnly) jobs release the key back to active on completion.
  if (isOneTimeKey) {
    const claimed = await container.apiKeyRepository.claimForJob(auth.keyId, job.id);
    if (!claimed) {
      // Before cleaning up, check if the winner of a same-key race already claimed
      // this exact job. If so, this is an idempotent duplicate — don't corrupt the winner.
      const keyRecord = await container.apiKeyRepository.findByKeyId(auth.keyId);
      if (keyRecord?.currentJobId === job.id && keyRecord?.status === "in_use") {
        logger.info("Same-key duplicate detected — winner already claimed this job", {
          keyId: auth.keyId, jobId: job.id,
        });
        return NextResponse.json(serializeJobResponse(job), { status: 200 });
      }

      // Genuine claim failure (key revoked, consumed, or claimed for a different job).
      // Delete the orphaned job entirely so it doesn't count against the repo's rate limit.
      logger.warn("One-time key claim failed — deleting orphaned job", { keyId: auth.keyId, jobId: job.id });
      await container.jobRepository.deleteById(job.id).catch((cleanupErr) => {
        logger.error("Failed to delete orphaned job after key claim failure", {
          jobId: job.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      });
      return NextResponse.json(
        { error: "KEY_IN_USE", message: "A job is already in progress for this key" },
        { status: 429 },
      );
    }
    logger.info("One-time key claimed for job", { keyId: auth.keyId, jobId: job.id });
  }

  // Write legacy diff to temp file now that all checks have passed (pipeline will clean it up)
  if (legacyDiffStr !== null) {
    const tempPath = path.join(os.tmpdir(), `prvod-legacy-diff-${randomUUID()}.diff`);
    await fs.writeFile(tempPath, legacyDiffStr, { mode: 0o600 });
    prContext.diffSource = { kind: "local_diff_file", tempPath };
    logger.debug("POST /api/jobs: legacy diff field written to temp file", { tempPath });
  }

  // Fire-and-forget async processing
  const runner = createPipelineRunner(container, {
    apiKeyRepository: isOneTimeKey,
    githubService: true,
    diffSource: true,
  });
  runner.run(job.id, prContext, { scriptOnly, ttsOnly, apiKeyId: isOneTimeKey ? auth.keyId : undefined }).catch((e) => {
    logger.error("Pipeline runner error", {
      error: e instanceof Error ? e.message : "Unknown",
    });
  });

  return NextResponse.json(serializeJobResponse(job), { status: 201 });
});
