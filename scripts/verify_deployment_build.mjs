const [origin, expectedSha] = process.argv.slice(2);

if (!origin || !expectedSha) {
  console.error("Usage: node scripts/verify_deployment_build.mjs <origin> <expected-sha>");
  process.exit(2);
}

const normalizedOrigin = origin.replace(/\/$/, "");
const buildInfoUrl = `${normalizedOrigin}/api/build-info`;

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastError = null;

for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const response = await fetch(buildInfoUrl, {
      headers: {
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const info = await response.json();
    const actualSha = String(info.commitSha ?? "");

    if (actualSha === expectedSha || actualSha.startsWith(expectedSha.slice(0, 12))) {
      console.log(`Deployment verified at ${normalizedOrigin}: ${actualSha}`);
      process.exit(0);
    }

    throw new Error(`expected ${expectedSha}, got ${actualSha || "empty commitSha"}`);
  } catch (error) {
    lastError = error;
    console.log(`Waiting for deployment (${attempt}/12): ${error.message}`);
    await wait(10_000);
  }
}

console.error(`Deployment verification failed: ${lastError?.message ?? "unknown error"}`);
process.exit(1);
