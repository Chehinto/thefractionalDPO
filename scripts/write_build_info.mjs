import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function firstValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) ?? null;
}

const commitSha =
  firstValue(process.env.VERCEL_GIT_COMMIT_SHA, process.env.GITHUB_SHA, git(["rev-parse", "HEAD"])) ?? "unknown";
const commitRef =
  firstValue(
    process.env.VERCEL_GIT_COMMIT_REF,
    process.env.GITHUB_REF_NAME,
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
  ) ?? "unknown";

const info = {
  commitSha,
  commitRef,
  builtAt: new Date().toISOString(),
};

const outputDir = path.join(process.cwd(), "public");
mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(outputDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
console.log(`Wrote build info for ${commitSha.slice(0, 12)} (${commitRef})`);
