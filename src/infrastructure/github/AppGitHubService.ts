import { createLogger } from "@/lib/logger";
import { sanitizeErrorBody } from "@/lib/sanitize";
import type {
  DiscardPendingReviewParams,
  IGitHubService,
  SubmitPendingReviewParams,
  SyncDraftReviewCommentsParams,
} from "@/interfaces/IGitHubService";
import type { PRContext } from "@/domain/entities/PRContext";
import { prContextSchema } from "@/domain/entities/PRContext";
import type { GitHubAppTokenService } from "./GitHubAppTokenService";

const logger = createLogger("AppGitHubService");

const GITHUB_API = "https://api.github.com";
const MAX_LINKED_ISSUES = 5;

async function ghFetch(
  url: string,
  token: string,
  extra?: Record<string, string>,
): Promise<Response> {
  logger.debug("GitHub API request", { url });
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    },
  });
  if (!res.ok) {
    let body: string;
    try {
      body = sanitizeErrorBody(await res.text());
    } catch (readErr) {
      body = "[body unreadable]";
      logger.debug("Could not read error response body", {
        error: readErr instanceof Error ? readErr.message : String(readErr),
      });
    }
    logger.error("GitHub API error", { url, status: res.status, body });
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res;
}

function parseLinkedIssueNumbers(body: string | null): number[] {
  if (!body) return [];
  const seen = new Set<number>();
  for (const m of body.matchAll(/(?:^|\s|[,;(])#(\d+)/g)) {
    seen.add(parseInt(m[1], 10));
    if (seen.size >= MAX_LINKED_ISSUES) break;
  }
  return [...seen];
}

function encodeGitHubPath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function splitRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repoFullName: ${repoFullName}`);
  }
  return { owner, repo };
}

export class AppGitHubService implements IGitHubService {
  constructor(private readonly tokenService: GitHubAppTokenService) {}

  async fetchPRContext(
    repoFullName: string,
    prNumber: number,
    installationId?: number,
  ): Promise<PRContext> {
    if (!installationId) {
      throw new Error("AppGitHubService requires installationId for fetchPRContext");
    }
    const token = await this.tokenService.getToken(installationId);
    logger.info("Fetching PR context", { repo: repoFullName, pr: prNumber, installationId });

    const prUrl = `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`;

    const prRes = await ghFetch(prUrl, token);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pr: any = await prRes.json();

    logger.debug("PR metadata fetched", {
      repo: repoFullName,
      pr: prNumber,
      title: pr.title,
    });

    const issueNumbers = parseLinkedIssueNumbers(pr.body as string | null);
    logger.debug("Linked issues found", { repo: repoFullName, pr: prNumber, issueNumbers });

    const issueResults = await Promise.allSettled(
      issueNumbers.map(async (n) => {
        const res = await ghFetch(`${GITHUB_API}/repos/${repoFullName}/issues/${n}`, token);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const issue: any = await res.json();
        return {
          number: issue.number as number,
          title: (issue.title as string) ?? "",
          body: (issue.body as string) ?? "",
        };
      }),
    );

    const issues = issueResults
      .filter(
        (r): r is PromiseFulfilledResult<{ number: number; title: string; body: string }> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value);

    const failedIssues = issueResults
      .map((r, i) => ({ result: r, issueNumber: issueNumbers[i] }))
      .filter(
        (x): x is { result: PromiseRejectedResult; issueNumber: number } =>
          x.result.status === "rejected",
      );

    if (failedIssues.length > 0) {
      logger.warn("Some linked issues could not be fetched", {
        repo: repoFullName,
        pr: prNumber,
        failedIssues: failedIssues.map((x) => ({
          number: x.issueNumber,
          reason:
            x.result.reason instanceof Error
              ? x.result.reason.message
              : String(x.result.reason),
        })),
      });
    }

    let milestone: { title: string; description: string } | null = null;
    if (pr.milestone) {
      milestone = {
        title: (pr.milestone.title as string) ?? "",
        description: (pr.milestone.description as string) ?? "",
      };
      logger.debug("Milestone found", {
        repo: repoFullName,
        pr: prNumber,
        milestone: milestone.title,
      });
    }

    const rawContext = {
      repoFullName,
      prNumber,
      prTitle: (pr.title as string) ?? "",
      prDescription: (pr.body as string) ?? "",
      diffSource: {
        kind: "github_pr" as const,
        repoFullName,
        prNumber,
        installationId,
      },
      baseBranch: (pr.base?.ref as string) ?? "",
      headBranch: (pr.head?.ref as string) ?? "",
      headRepoFullName: (pr.head?.repo?.full_name as string) ?? repoFullName,
      headSha: (pr.head?.sha as string) ?? "",
      issues,
      milestone,
      isPrivate: (pr.base?.repo?.private as boolean) ?? false,
    };

    const parsed = prContextSchema.parse(rawContext);
    const context: PRContext = parsed;
    logger.info("PR context ready", {
      repo: repoFullName,
      pr: prNumber,
      issueCount: issues.length,
      hasMilestone: milestone !== null,
    });
    return context;
  }

  async fetchRepositoryFiles(
    repoFullName: string,
    ref: string,
    filePaths: string[],
    installationId?: number,
  ): Promise<Record<string, string>> {
    if (!installationId) {
      throw new Error("AppGitHubService requires installationId for fetchRepositoryFiles");
    }
    const token = await this.tokenService.getToken(installationId);
    const uniquePaths = [...new Set(filePaths.filter(Boolean))].sort();
    if (uniquePaths.length === 0) {
      return {};
    }

    logger.info("Fetching repository files for review graph", {
      repo: repoFullName,
      ref,
      installationId,
      fileCount: uniquePaths.length,
    });

    const results = await Promise.allSettled(
      uniquePaths.map(async (filePath) => {
        const url = `${GITHUB_API}/repos/${repoFullName}/contents/${encodeGitHubPath(filePath)}?ref=${encodeURIComponent(ref)}`;
        const res = await ghFetch(url, token);
        const payload = await res.json() as {
          type?: string;
          encoding?: string;
          content?: string;
        };
        if (payload.type !== "file" || typeof payload.content !== "string") {
          throw new Error("GitHub contents response is not a file payload");
        }
        if (payload.encoding !== "base64") {
          throw new Error(`Unsupported GitHub contents encoding: ${payload.encoding ?? "unknown"}`);
        }
        const content = Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
        return [filePath, content] as const;
      }),
    );

    const files: Record<string, string> = {};
    const failures: Array<{ filePath: string; reason: string }> = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        const [filePath, content] = result.value;
        files[filePath] = content;
        return;
      }
      failures.push({
        filePath: uniquePaths[index],
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    if (failures.length > 0) {
      logger.warn("Some repository files could not be fetched for review graph", {
        repo: repoFullName,
        ref,
        installationId,
        failures,
      });
    }

    return files;
  }

  async postComment(
    repoFullName: string,
    prNumber: number,
    body: string,
    installationId?: number,
  ): Promise<void> {
    if (!installationId) {
      throw new Error("AppGitHubService requires installationId for postComment");
    }
    const token = await this.tokenService.getToken(installationId);
    logger.info("Posting comment on PR", { repo: repoFullName, pr: prNumber, installationId });

    const url = `${GITHUB_API}/repos/${repoFullName}/issues/${prNumber}/comments`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });

    if (!res.ok) {
      let errBody: string;
      try {
        errBody = sanitizeErrorBody(await res.text());
      } catch (readErr) {
        errBody = "[body unreadable]";
        logger.debug("Could not read error response body", {
          error: readErr instanceof Error ? readErr.message : String(readErr),
        });
      }
      logger.error("Failed to post comment", {
        repo: repoFullName,
        pr: prNumber,
        status: res.status,
        body: errBody,
      });
      throw new Error(`Failed to post comment: GitHub API ${res.status}: ${errBody}`);
    }

    logger.info("Comment posted successfully", { repo: repoFullName, pr: prNumber });
  }

  async syncDraftReviewComments(
    params: SyncDraftReviewCommentsParams,
  ): Promise<{ pendingReviewId: number; commentCount: number }> {
    const { owner, repo } = splitRepoFullName(params.repoFullName);

    // GitHub does not support editing comments on a PENDING review in bulk.
    // Delete the previous pending review and create a fresh one so the
    // comment set always reflects the current local draft state exactly.
    if (params.pendingReviewId) {
      await this.deletePendingReview(
        owner,
        repo,
        params.prNumber,
        params.pendingReviewId,
        params.reviewerAccessToken,
      );
    }

    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${params.prNumber}/reviews`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.reviewerAccessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          commit_id: params.commitId,
          body: params.summary ?? "Drafted from the review walkthrough.",
          comments: params.comments.map(({ path, body, position }) => ({ path, body, position })),
        }),
      },
    );

    if (!res.ok) {
      const body = sanitizeErrorBody(await res.text());
      throw new Error(`GitHub create pending review failed (${res.status}): ${body}`);
    }

    const json = await res.json() as { id?: number };
    if (typeof json.id !== "number") {
      throw new Error("GitHub create pending review response missing review id");
    }

    return {
      pendingReviewId: json.id,
      commentCount: params.comments.length,
    };
  }

  async submitPendingReview(
    params: SubmitPendingReviewParams,
  ): Promise<{ submittedReviewId: number }> {
    const { owner, repo } = splitRepoFullName(params.repoFullName);
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${params.prNumber}/reviews/${params.pendingReviewId}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.reviewerAccessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event: "COMMENT",
          body: params.body ?? "Submitted from the review walkthrough.",
        }),
      },
    );

    if (!res.ok) {
      const body = sanitizeErrorBody(await res.text());
      throw new Error(`GitHub submit pending review failed (${res.status}): ${body}`);
    }

    const json = await res.json() as { id?: number };
    if (typeof json.id !== "number") {
      throw new Error("GitHub submit pending review response missing review id");
    }

    return { submittedReviewId: json.id };
  }

  async discardPendingReview(params: DiscardPendingReviewParams): Promise<void> {
    const { owner, repo } = splitRepoFullName(params.repoFullName);
    await this.deletePendingReview(
      owner,
      repo,
      params.prNumber,
      params.pendingReviewId,
      params.reviewerAccessToken,
    );
  }

  private async deletePendingReview(
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: number,
    reviewerAccessToken: string,
  ): Promise<void> {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${reviewerAccessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!res.ok) {
      const body = sanitizeErrorBody(await res.text());
      throw new Error(`GitHub delete pending review failed (${res.status}): ${body}`);
    }
  }

}
