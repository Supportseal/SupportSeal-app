import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // The dev MCP server logs every dev-server request to
    // .next/dev/logs/next-development.log inside Turbopack's watch scope;
    // each write triggers a Fast Refresh rebuild + full page reload, which
    // stalls e2e signup flows under load. E2E bootstraps set
    // NEXT_DEV_MCP=0 to opt out; regular `next dev` keeps the tooling.
    mcpServer: process.env.NEXT_DEV_MCP !== "0",
  },
  async headers() {
    return [
      {
        // Global security headers. Widget surfaces are excluded: the panel
        // sets its own CSP frame-ancestors, and the loader/preview must stay
        // embeddable.
        source: "/((?!widget|widget-preview|api/widget|api/attachments).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        // Downloadable attachments: nosniff everywhere; framing not needed.
        source: "/api/attachments/:path*",
        headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
      },
    ];
  },
  // Widget assets served by route handlers under /api/widget/* (docs/design/chat-widget.md).
  async rewrites() {
    return [
      { source: "/widget.js", destination: "/api/widget/js" },
      { source: "/widget", destination: "/api/widget/panel" },
      { source: "/widget-diagnostics.js", destination: "/api/widget/diagnostics-js" },
      // Plain-markdown twin of every docs page, for agents (/docs/llms.txt lists them).
      { source: "/docs/:slug([a-z-]+).md", destination: "/docs/raw/:slug" },
    ];
  },
  // Opt in to LAN/dev hosts through DEV_ALLOWED_ORIGINS (comma-separated).
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ?? [],
};

export default nextConfig;
