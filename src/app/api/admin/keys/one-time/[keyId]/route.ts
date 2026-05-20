import { NextRequest, NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/apiMiddleware";

export const DELETE = withAdminAuth(async (
  _request: NextRequest,
  ctx,
  routeContext: { params: Promise<{ keyId: string }> },
) => {
  const { container, logger } = ctx;
  const { keyId } = await routeContext.params;

  const existing = await container.apiKeyRepository.findByKeyId(keyId);
  if (!existing || existing.maxUses === null) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No one-time key with this keyId exists" },
      { status: 404 },
    );
  }

  // Idempotent: revoking consumed or already-revoked keys succeeds silently
  if (existing.status !== "revoked") {
    await container.apiKeyRepository.revoke(keyId);
  }

  logger.info("One-time API key revoked", { keyId, previousStatus: existing.status });

  // Re-fetch to get authoritative revokedAt timestamp from DB
  const updated = await container.apiKeyRepository.findByKeyId(keyId);
  if (!updated) {
    logger.warn("Re-fetch after revoke returned null — key may have been deleted concurrently", { keyId });
  }

  return NextResponse.json({
    keyId,
    status: "revoked",
    revokedAt: (updated?.revokedAt ?? existing.revokedAt ?? new Date()).toISOString(),
  });
});
