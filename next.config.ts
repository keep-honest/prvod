import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { NextConfig } from "next";
import type { Configuration as WebpackConfig } from "webpack";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf-8"));
if (!version) {
  throw new Error(`APP_VERSION could not be read from ${pkgPath}. Ensure package.json has a "version" field.`);
}

const isRuntimeDevelopment = process.env.NODE_ENV !== "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isRuntimeDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Allow external avatar images (GitHub avatars + any HTTPS URL users provide as custom avatars).
  // data: supports inline base64 fallbacks.
  "img-src 'self' data: https:",
  "media-src 'self' https: blob: data:",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    APP_VERSION: version,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Next.js requires 'unsafe-inline' for hydration scripts and inline styles.
          // Non-production runtimes also need 'unsafe-eval' for React Fast Refresh/source maps.
          // Review pages stream signed video URLs from object storage, so media-src must allow remote media.
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy,
          },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  webpack(config: WebpackConfig, { isServer }: { isServer: boolean }) {
    if (isServer) {
      // Mark Node.js built-in modules used by instrumentation.ts as external.
      // Without this, webpack's static analysis tries to bundle them and fails
      // because they are runtime-only in Node.js.
      const prev = config.externals;
      config.externals = [
        ...(Array.isArray(prev) ? prev : prev ? [prev] : []),
        "net",
      ];
    }
    return config;
  },
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "@remotion/cli",
    "remotion",
    "esbuild",
    "webpack",
    // pg uses Node.js built-ins (fs, net, tls, stream) — must not be bundled
    "pg",
    "pg-pool",
    "pg-connection-string",
  ],
};

export default nextConfig;
