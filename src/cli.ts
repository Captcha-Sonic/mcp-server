#!/usr/bin/env node
/**
 * Local stdio MCP server.
 *
 *   claude mcp add captchasonic --env SONIC_API_KEY=sonic_xxx -- npx -y @captchasonic/mcp-server
 *
 * Env: SONIC_API_KEY (required for solving), SONIC_BASE_URL (default https://api.captchasonic.com).
 * Prefer the hosted server when your client supports remote MCP: https://mcp.captchasonic.com
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCaptchaSonicServer } from "./server.js";

const server = createCaptchaSonicServer({
  apiKey: process.env.SONIC_API_KEY ?? "",
  baseUrl: process.env.SONIC_BASE_URL || undefined,
  mode: "local",
});
await server.connect(new StdioServerTransport());
