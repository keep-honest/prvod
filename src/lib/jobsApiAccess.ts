import { NextResponse } from "next/server";

export function isJobsApiEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function jobsApiDisabledResponse(): NextResponse {
  return NextResponse.json(
    { error: "NOT_FOUND", message: "Not found" },
    { status: 404 },
  );
}
