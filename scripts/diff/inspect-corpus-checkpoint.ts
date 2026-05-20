#!/usr/bin/env tsx
/**
 * Show the DiffMetadataCorpus stored in a local pipeline checkpoint.
 *
 * Usage:
 *   npx tsx scripts/diff/inspect-corpus-checkpoint.ts --job-id <uuid> [--verbose]
 *
 * The checkpoint lives at:
 *   .local-storage/cache/<jobId>/checkpoint.json
 *
 * Flags:
 *   --job-id <uuid>   Job ID to inspect (required)
 *   --verbose         Print each file entry, not just the summary
 *   --list-jobs       List all jobs that have a checkpoint file
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PipelineCheckpoint } from "@/interfaces/IPipelineCheckpoint";

const CHECKPOINT_BASE = join(process.cwd(), ".local-storage", "cache");

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--verbose" || key === "--list-jobs") {
      args[key.slice(2)] = true;
    } else if (key.startsWith("--") && i + 1 < argv.length) {
      args[key.slice(2)] = argv[++i];
    }
  }
  return args;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function listJobs(): void {
  if (!existsSync(CHECKPOINT_BASE)) {
    console.log(`No checkpoint directory found at ${CHECKPOINT_BASE}`);
    console.log("Run a job with STORAGE_PROVIDER=local first.");
    return;
  }
  const jobDirs = readdirSync(CHECKPOINT_BASE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (jobDirs.length === 0) {
    console.log("No job checkpoints found.");
    return;
  }

  console.log(`Found ${jobDirs.length} job checkpoint(s) in ${CHECKPOINT_BASE}:\n`);
  for (const jobId of jobDirs) {
    const checkpointPath = join(CHECKPOINT_BASE, jobId, "checkpoint.json");
    if (!existsSync(checkpointPath)) continue;

    const raw = JSON.parse(readFileSync(checkpointPath, "utf8")) as PipelineCheckpoint;
    const corpus = raw.diffCorpus;
    const corpusSummary = corpus
      ? `corpus: ${Object.keys(corpus.files).length} files, ${corpus.totalLines} lines, ${corpus.segmentCount} segment(s)`
      : "no corpus";

    console.log(`  ${jobId}  step=${raw.completedStep}  ${corpusSummary}`);
  }
}

function inspectJob(jobId: string, verbose: boolean): void {
  const checkpointPath = join(CHECKPOINT_BASE, jobId, "checkpoint.json");

  if (!existsSync(checkpointPath)) {
    console.error(`No checkpoint found for job ${jobId}`);
    console.error(`Expected: ${checkpointPath}`);
    console.error("Run --list-jobs to see available jobs.");
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(checkpointPath, "utf8")) as PipelineCheckpoint;

  console.log(`\nCheckpoint for job: ${jobId}`);
  console.log(`  Completed step: ${raw.completedStep}`);

  if (raw.prContext) {
    const ctx = raw.prContext;
    console.log(`\nPRContext:`);
    console.log(`  repo:         ${ctx.repoFullName}`);
    console.log(`  PR:           #${ctx.prNumber}`);
    console.log(`  title:        ${ctx.prTitle}`);
    console.log(`  diffSource:   ${ctx.diffSource.kind}`);
    if (ctx.diffSource.kind === "local_diff_file") {
      console.log(`  tempPath:     ${ctx.diffSource.tempPath}`);
    }
  }

  const corpus = raw.diffCorpus;
  if (!corpus) {
    console.log("\nDiffMetadataCorpus: (not present — diff corpus was not checkpointed)");
    console.log("  Either the job used an old code path, or corpus build failed.");
    return;
  }

  const fileEntries = Object.entries(corpus.files);
  const oversizedFiles = fileEntries.filter(([, f]) => f.analysis?.wasChunked === true);
  const summaryBytes = JSON.stringify(corpus).length;

  console.log(`\nDiffMetadataCorpus:`);
  console.log(`  sourceType:     ${corpus.sourceType}`);
  console.log(`  isComplete:     ${corpus.isComplete}`);
  console.log(`  segmentCount:   ${corpus.segmentCount}`);
  console.log(`  totalFiles:     ${fileEntries.length}`);
  console.log(`  totalLines:     ${corpus.totalLines.toLocaleString()}`);
  console.log(`  chunkedFiles:   ${corpus.chunkedFileCount} (rolling summary applied)`);
  console.log(`  corpusSize:     ~${fmtBytes(summaryBytes)} (JSON-serialised)`);

  if (oversizedFiles.length > 0) {
    console.log(`\n  Oversized files (wasChunked=true):`);
    for (const [filePath, f] of oversizedFiles) {
      const analysis = f.analysis as { wasChunked: true; chunkCount?: number; rollingSummary?: string };
      const summaryLen = analysis.rollingSummary?.length ?? 0;
      console.log(`    ${filePath}`);
      console.log(`      chunks:  ${analysis.chunkCount ?? "?"}`);
      console.log(`      summary: ${summaryLen} chars`);
    }
  }

  if (verbose) {
    console.log(`\n  All files:`);
    const sorted = fileEntries.sort(([, a], [, b]) => b.importanceScore - a.importanceScore);
    for (const [filePath, f] of sorted) {
      const chunked = f.analysis?.wasChunked === true ? " [chunked]" : "";
      const score = f.importanceScore.toFixed(2);
      console.log(
        `    [${score}] ${filePath}  +${f.linesAdded}/-${f.linesRemoved} ${f.changeType}${chunked}`,
      );
    }
  } else if (fileEntries.length > 0) {
    console.log(`\n  Top 10 files by importance score:`);
    const top10 = fileEntries
      .sort(([, a], [, b]) => b.importanceScore - a.importanceScore)
      .slice(0, 10);
    for (const [filePath, f] of top10) {
      const chunked = f.analysis?.wasChunked === true ? " [chunked]" : "";
      const score = f.importanceScore.toFixed(2);
      console.log(`    [${score}] ${filePath}  +${f.linesAdded}/-${f.linesRemoved}${chunked}`);
    }
    if (fileEntries.length > 10) {
      console.log(`    ... and ${fileEntries.length - 10} more (use --verbose to see all)`);
    }
  }

  console.log("");
}

const args = parseArgs(process.argv);

if (args["list-jobs"]) {
  listJobs();
} else if (args["job-id"]) {
  inspectJob(String(args["job-id"]), args["verbose"] === true);
} else {
  console.error("Usage:");
  console.error("  npx tsx scripts/diff/inspect-corpus-checkpoint.ts --job-id <uuid> [--verbose]");
  console.error("  npx tsx scripts/diff/inspect-corpus-checkpoint.ts --list-jobs");
  process.exit(1);
}
