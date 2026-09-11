/** @type {import('next').NextConfig} */
const nextConfig = {
  // Playwright drives the dev server over 127.0.0.1; without this, Next blocks
  // its own HMR assets as a cross-origin dev request and floods the test log.
  allowedDevOrigins: ["127.0.0.1"],
};
export default nextConfig;
