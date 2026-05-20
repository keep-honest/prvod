import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    version: process.env.APP_VERSION ?? "unknown",
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
