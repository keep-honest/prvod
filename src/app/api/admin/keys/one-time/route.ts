import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { withAdminAuth } from "@/lib/apiMiddleware";

const CreateOneTimeKeySchema = z.object({
  label: z.string().max(255).optional(),
});

export const POST = withAdminAuth(async (_request: NextRequest, ctx) => {
  const { container, auth, logger } = ctx;

  let body: unknown = {};
  try {
    body = await _request.json();
  } catch {
    const contentType = _request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return NextResponse.json(
        { error: "BAD_REQUEST", message: "Malformed JSON body" },
        { status: 400 },
      );
    }
    // Truly empty body is fine — label is optional
  }

  const parsed = CreateOneTimeKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_INPUT", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { label } = parsed.data;

  const keyId = "pk_" + randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const pepper = process.env.APP_ENCRYPTION_KEY ?? "";
  if (!pepper) {
    if (process.env.NODE_ENV === "production") {
      logger.error("Cannot create API key: APP_ENCRYPTION_KEY is not set");
      return NextResponse.json(
        { error: "SERVER_CONFIGURATION_ERROR", message: "Server misconfigured — cannot create keys" },
        { status: 500 },
      );
    }
    logger.warn("APP_ENCRYPTION_KEY is not set — key will be hashed without pepper (insecure)");
  }

  const { hash } = await import("@node-rs/argon2");
  const keyHash = await hash(pepper + secret);

  const record = await container.apiKeyRepository.create({
    keyId,
    keyHash,
    name: label ?? "one-time-key",
    isAdmin: false,
    scopes: ["jobs:create", "jobs:read"],
    maxUses: 1,
    label: label ?? undefined,
  });

  logger.info("One-time API key created", {
    keyId: record.keyId,
    label: record.label,
    createdBy: auth.keyId,
  });

  return NextResponse.json(
    {
      keyId: record.keyId,
      apiKey: `${keyId}.${secret}`,
      label: record.label,
      status: record.status,
      maxUses: record.maxUses,
      usesCount: record.usesCount,
      createdAt: record.createdAt.toISOString(),
    },
    { status: 201 },
  );
});

export const GET = withAdminAuth(async (_request: NextRequest, ctx) => {
  const { container, logger } = ctx;

  const keys = await container.apiKeyRepository.findOneTimeKeys();

  logger.debug("Listed one-time API keys", { count: keys.length });

  return NextResponse.json({
    keys: keys.map((k) => ({
      keyId: k.keyId,
      label: k.label,
      status: k.status,
      maxUses: k.maxUses,
      usesCount: k.usesCount,
      currentJobId: k.currentJobId,
      createdAt: k.createdAt.toISOString(),
      consumedAt: k.consumedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
    })),
  });
});
