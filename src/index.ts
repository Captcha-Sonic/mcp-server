#!/usr/bin/env node
/**
 * CaptchaSonic MCP Server
 * ======================
 * Exposes 3 tools via the Model Context Protocol so Claude (or any MCP-compatible
 * AI agent) can solve CAPTCHAs, check balance, and verify server health.
 *
 * Setup:
 *   claude mcp add sonic --env SONIC_API_KEY=sonic_xxxx -- npx -y @captchasonic/mcp-server
 *
 * Environment variables:
 *   SONIC_API_KEY   — your CaptchaSonic API key (required for get_balance, solve_captcha)
 *   SONIC_BASE_URL  — override server URL (default: https://api.captchasonic.com)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createClient } from "@connectrpc/connect";
import { SonicService } from "captchasonic";

const API_KEY = process.env.SONIC_API_KEY ?? "";
const BASE_URL = process.env.SONIC_BASE_URL ?? "https://api.captchasonic.com";

// The ConnectRPC handler is served under /rpc (nginx routes
// /rpc/captchasonic.v1.SonicService/* to the Connect backend). Append it unless
// the user already supplied a path. Connect runs over HTTP/1.1 here — forcing
// httpVersion "2" makes connect-node attempt an h2 ALPN handshake the TLS
// endpoint rejects ("no application protocol").
function connectUrl(base: string): string {
  try {
    const u = new URL(base);
    if (u.pathname !== "/" && u.pathname !== "") return base;
  } catch {
    /* not a full URL — fall through to append */
  }
  return base.replace(/\/$/, "") + "/rpc";
}

const transport = createConnectTransport({ baseUrl: connectUrl(BASE_URL), httpVersion: "1.1" });
const rpc = createClient(SonicService, transport);

const server = new Server(
  { name: "sonic-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "health_check",
      description:
        "Check if the CaptchaSonic API server is healthy and get the server version. No API key required.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_balance",
      description:
        "Get the current CaptchaSonic account balance in USD. Requires SONIC_API_KEY environment variable.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "solve_captcha",
      description:
        "Submit a CAPTCHA image for solving. Supports PopularCaptcha, reCAPTCHA, Geetest, AWS WAF, TikTok, Binance, OCR and more. " +
        "Returns the solution: grid object indices, text answers, slide offset, or click coordinates depending on type.",
      inputSchema: {
        type: "object",
        required: ["type", "question"],
        properties: {
          type: {
            type: "string",
            description:
              "CAPTCHA type. Examples: PopularCaptchaImage (PopularCaptcha/reCAPTCHA grid), " +
              "geetest_slide, geetest_click, ocr, audio, turnstile",
          },
          question: {
            type: "string",
            description:
              "The challenge question shown to the user. E.g. 'Select all traffic lights'",
          },
          image_base64: {
            type: "string",
            description:
              "Base64-encoded PNG/JPEG image bytes. Provide this OR image_url, not both.",
          },
          image_url: {
            type: "string",
            description:
              "Public URL of the image. The server will fetch it. Provide this OR image_base64.",
          },
          website_url: {
            type: "string",
            description: "Optional: the page URL where the CAPTCHA appears (for context).",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "health_check") {
    const r = await rpc.healthCheck({});
    return {
      content: [
        {
          type: "text",
          text: `healthy: ${r.healthy}\nversion: ${r.version}`,
        },
      ],
    };
  }

  if (name === "get_balance") {
    if (!API_KEY) {
      return {
        content: [
          {
            type: "text",
            text: "Error: SONIC_API_KEY environment variable is not set. " +
              "Re-add the MCP server with: claude mcp add sonic --env SONIC_API_KEY=sonic_xxxx -- sonic-mcp",
          },
        ],
        isError: true,
      };
    }
    const r = await rpc.getBalance({ apiKey: API_KEY });
    return {
      content: [
        {
          type: "text",
          text: `balance: $${r.balance.toFixed(4)}\nstatus: ${r.status}\nerrorId: ${r.errorId}`,
        },
      ],
    };
  }

  if (name === "solve_captcha") {
    if (!API_KEY) {
      return {
        content: [{ type: "text", text: "Error: SONIC_API_KEY is not set." }],
        isError: true,
      };
    }

    // Build image bytes from base64 or URL
    let images: Uint8Array[] = [];
    if (args?.image_base64) {
      images = [Buffer.from(args.image_base64 as string, "base64")];
    }
    // Note: image_url is passed to the server via websiteURL field for reference

    const r = await rpc.createTask({
      apiKey: API_KEY,
      task: {
        type: args?.type as string,
        question: args?.question as string,
        images,
        websiteURL: (args?.image_url ?? args?.website_url ?? "") as string,
      },
    });

    if (r.errorId !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `Error from API: errorId=${r.errorId}, description=${r.errorDescription}`,
          },
        ],
        isError: true,
      };
    }

    // Format solution based on what's available
    const solution: Record<string, unknown> = {
      status: r.status,
      taskId: r.taskId,
    };

    // protobuf-es v2 represents the SolutionPayload oneof as a discriminated
    // `kind` union ({ case, value }), not as direct optional fields.
    const kind = r.typedSolution?.kind;
    if (kind?.case === "grid") {
      solution.type = "grid";
      solution.objects = Array.from(kind.value.objects);  // e.g. [1, 3, 5]
    } else if (kind?.case === "text") {
      solution.type = "text";
      solution.texts = kind.value.texts;                  // e.g. ["abc123"]
    } else if (kind?.case === "slide") {
      solution.type = "slide";
      solution.x = kind.value.x;                          // e.g. 42
    } else if (kind?.case === "click") {
      solution.type = "click";
      solution.groups = kind.value.groups.map((g) => ({
        clicks: g.coords.map((c) => ({ x: c.x, y: c.y })),
      }));
    } else if (kind?.case === "single") {
      solution.type = "single";
      solution.hasObject = Array.from(kind.value.hasObject);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(solution, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);
