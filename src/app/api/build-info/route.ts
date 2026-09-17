/**
 * What commit is actually serving this request.
 *
 * The deploy workflows read this back from the live domain after deploying and
 * fail the run when the answer is not the commit that triggered them. Without
 * it a deploy that quietly changed nothing — a swung alias that did not swing,
 * a build served from cache — looks exactly like a successful one.
 *
 * Deliberately unauthenticated: it exposes only a commit SHA and branch name,
 * both already public in a public repository, and the verification step runs
 * before any session exists to authenticate with.
 */

import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Never cached or prerendered: a cached answer is the exact failure this route
// exists to detect.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const generated = await readGeneratedBuildInfo();

  return NextResponse.json({
    commitSha: generated.commitSha ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "unknown",
    commitRef: generated.commitRef ?? process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GITHUB_REF_NAME ?? "unknown",
    builtAt: generated.builtAt ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? "local",
    checkedAt: new Date().toISOString(),
  });
}

/**
 * Written by `scripts/write_build_info.mjs` during `prebuild`. Absent when the
 * app runs from `next dev`, which is why every field falls back rather than
 * throwing.
 */
async function readGeneratedBuildInfo() {
  try {
    const raw = await readFile(path.join(process.cwd(), "public", "build-info.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      commitSha: typeof parsed.commitSha === "string" ? parsed.commitSha : null,
      commitRef: typeof parsed.commitRef === "string" ? parsed.commitRef : null,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : null,
    };
  } catch {
    return { commitSha: null, commitRef: null, builtAt: null };
  }
}
