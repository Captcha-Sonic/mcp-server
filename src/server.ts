/**
 * CaptchaSonic MCP server: tool definitions shared by the local stdio binary
 * (`sonic-mcp`) and the hosted server at https://mcp.captchasonic.com.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DASHBOARD_URL, SonicApi, SonicApiError, sleep } from "./api.js";
import {
  IMAGE_TYPES,
  IMAGE_TYPE_IDS,
  TOKEN_TYPES,
  TOKEN_TYPE_IDS,
  imageType,
  tokenType,
  type Field,
} from "./catalog.js";
import { assertTotalSize, normalizeImages } from "./images.js";

export const VERSION = "2.0.0";

const POLL_INTERVAL_MS = 3000;
const DEFAULT_TASK_TIMEOUT_SEC = 120;
/** Extra time beyond the task timeout before giving up on polling. */
const POLL_GRACE_SEC = 15;

export interface CaptchaSonicServerOptions {
  /** CaptchaSonic API key (sonic_...). */
  apiKey: string;
  /** Solving API base URL. Default https://api.captchasonic.com */
  baseUrl?: string;
  /** Allow image inputs given as http(s) URLs (downloaded by this server). Default true. */
  allowImageUrls?: boolean;
  /** Identifies the caller to the API, e.g. "hosted" or "local". */
  mode?: string;
  fetch?: typeof fetch;
}

const INSTRUCTIONS = `CaptchaSonic solves CAPTCHAs for automation.

Two kinds of CAPTCHA:
- Token CAPTCHAs (reCAPTCHA, Turnstile, Cloudflare challenge, hCaptcha-style, GeeTest, MTCaptcha): call solve_token_captcha with the page URL and sitekey. You get a token to submit with the page's form (e.g. g-recaptcha-response, cf-turnstile-response). Solving takes 5-60s.
- Image CAPTCHAs (grids, sliders, OCR text, click challenges): screenshot or download the challenge images and call solve_image_captcha. The answer comes back immediately.

Call list_captcha_types first if you are unsure which type or fields to use. Solves are billed per request; failed solves are refunded.`;

type ToolExtra = {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>;
};

export function createCaptchaSonicServer(opts: CaptchaSonicServerOptions): McpServer {
  const api = new SonicApi({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    userAgent: `captchasonic-mcp/${VERSION} (${opts.mode ?? "local"})`,
    fetch: opts.fetch,
  });
  const allowUrls = opts.allowImageUrls ?? true;

  const server = new McpServer(
    { name: "captchasonic", title: "CaptchaSonic", version: VERSION, websiteUrl: "https://captchasonic.com" },
    { instructions: INSTRUCTIONS },
  );

  const requireKey = () => {
    if (!api.hasKey) {
      throw new SonicApiError(
        "ERROR_KEY_DOES_NOT_EXIST",
        "No CaptchaSonic API key configured.",
        `Get a key at ${DASHBOARD_URL} and set SONIC_API_KEY (local) or the Authorization: Bearer header (hosted).`,
      );
    }
  };

  // ── solve_token_captcha ────────────────────────────────────────────────
  server.registerTool(
    "solve_token_captcha",
    {
      title: "Solve token CAPTCHA",
      description:
        "Solve a token-based CAPTCHA on a web page (reCAPTCHA v2/v3, Cloudflare Turnstile, Cloudflare challenge, hCaptcha-style PopularCaptcha, GeeTest, MTCaptcha). " +
        "Returns a token to submit with the page's form; for cloudflare_challenge use the returned cookies and userAgent. Waits until solved (usually 5-60s).",
      inputSchema: {
        type: z.enum(TOKEN_TYPE_IDS).describe("CAPTCHA type. See list_captcha_types."),
        website_url: z.string().min(1).max(2048).describe("Full URL of the page showing the CAPTCHA."),
        website_key: z
          .string()
          .optional()
          .describe("Site key from the page (data-sitekey, render= param, captchaId). Required for most types."),
        proxy: z
          .string()
          .optional()
          .describe("Optional proxy to solve through, e.g. http://user:pass@1.2.3.4:8080. Omit to solve without a proxy."),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Extra challenge data, e.g. { rqdata } for enterprise hCaptcha or { gt, challenge } for GeeTest v3."),
        task_timeout: z.number().int().min(60).max(120).optional().describe("Seconds the solver may take (60-120, default 120)."),
        wait_for_result: z
          .boolean()
          .optional()
          .describe("Default true. Set false to return a task_id immediately and poll with get_task_result."),
      },
      outputSchema: tokenResultShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      run(async () => {
        requireKey();
        const def = tokenType(args.type)!;
        assertRequired(def.required, args, def.id);
        const useProxy = !!args.proxy || def.apiTypeProxyless === null;
        const task: Record<string, unknown> = {
          type: useProxy ? def.apiType : def.apiTypeProxyless,
          websiteURL: args.website_url,
        };
        if (args.website_key) task.websiteKey = args.website_key.trim();
        if (args.proxy) task.proxy = args.proxy;
        if (args.metadata) task.metadata = args.metadata;
        if (args.task_timeout) task.taskTimeout = args.task_timeout;

        const created = await api.createTask(task, extra.signal);
        const taskId = typeof created.taskId === "string" ? created.taskId : undefined;
        if (!taskId) throw new SonicApiError("ERROR_NO_TASK_ID", "The API did not return a task id.");
        if (args.wait_for_result === false) {
          return tokenResult({ taskId, status: "processing" });
        }
        const deadline = Date.now() + ((args.task_timeout ?? DEFAULT_TASK_TIMEOUT_SEC) + POLL_GRACE_SEC) * 1000;
        return pollTask(api, taskId, deadline, extra as unknown as ToolExtra);
      }),
  );

  // ── solve_image_captcha ────────────────────────────────────────────────
  server.registerTool(
    "solve_image_captcha",
    {
      title: "Solve image CAPTCHA",
      description:
        "Solve an image or audio CAPTCHA: image grids (hCaptcha-style, reCAPTCHA, AWS WAF, GeeTest nine), sliders (GeeTest, TikTok, Binance, Tencent, generic), click challenges, OCR text and audio. " +
        "Pass the challenge images and the prompt text. Returns the answer immediately; see answer_format for how to apply it.",
      inputSchema: {
        type: z.enum(IMAGE_TYPE_IDS).describe("CAPTCHA type. See list_captcha_types."),
        images: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe("Challenge images in order: raw base64, data: URLs, or public http(s) URLs. Max 5 MB each and about 7.8 MB for all images together."),
        question: z.string().max(500).optional().describe("The challenge prompt exactly as shown, e.g. 'Select all images with a bus'."),
        question_type: z
          .string()
          .optional()
          .describe("Challenge layout for popularcaptcha_image: objectClassify, objectClick, objectDrag, objectTag, grid, bbox, bboxdd."),
        examples: z
          .array(z.string().min(1))
          .max(3)
          .optional()
          .describe("Reference images: the puzzle piece for sliders, example images for classify challenges."),
        website_url: z.string().max(2048).optional().describe("Page URL where the CAPTCHA appears (improves some solvers)."),
        module: z.string().optional().describe("OCR only: recognition module, e.g. 'common' (default) or 'bls'."),
        numeric: z.boolean().optional().describe("OCR only: answer contains digits only."),
        case_sensitive: z.boolean().optional().describe("OCR only: answer is case-sensitive."),
        max_length: z.number().int().min(1).max(64).optional().describe("OCR only: maximum answer length."),
      },
      outputSchema: imageResultShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      run(async () => {
        requireKey();
        const def = imageType(args.type)!;
        assertRequired(def.required, args, def.id);
        const imageOpts = { allowUrls, fetch: opts.fetch };
        const [images, examples] = await Promise.all([
          normalizeImages(args.images, imageOpts, extra.signal),
          args.examples ? normalizeImages(args.examples, imageOpts, extra.signal) : Promise.resolve(undefined),
        ]);
        assertTotalSize(images, examples);
        const task: Record<string, unknown> = { type: def.apiType, images };
        if (args.question) task.question = args.question;
        if (args.question_type) task.questionType = args.question_type;
        if (examples) task.examples = examples;
        if (args.website_url) task.websiteURL = args.website_url;
        if (args.module) task.module = args.module;
        if (args.numeric !== undefined) task.numeric = args.numeric;
        if (args.case_sensitive !== undefined) task.case = args.case_sensitive;
        if (args.max_length) task.maxLength = args.max_length;

        const body = await api.createTask(task, extra.signal);
        // AudioTask answers in token shape ({ errorId: 0, solution }); all others use { code: 200, answers }.
        const answers = "answers" in body ? body.answers : body.solution;
        const out = {
          type: def.id,
          answers,
          answer_format: def.answerFormat,
          question_type: typeof body.questionType === "string" ? body.questionType : undefined,
          size: body.size,
          warning: typeof body.warning === "string" ? body.warning : undefined,
        };
        return ok(out, `Solved ${def.label}.\nanswers: ${JSON.stringify(answers)}\nFormat: ${def.answerFormat}`);
      }),
  );

  // ── get_task_result ────────────────────────────────────────────────────
  server.registerTool(
    "get_task_result",
    {
      title: "Get token task result",
      description:
        "Check a token task started by solve_token_captcha (when it returned status 'processing'). Returns the token once ready. Results expire a few minutes after they are ready.",
      inputSchema: {
        task_id: z.string().min(1).max(128).describe("task_id returned by solve_token_captcha."),
      },
      outputSchema: tokenResultShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) =>
      run(async () => {
        requireKey();
        const body = await api.getTaskResult(args.task_id, extra.signal);
        return interpretTaskResult(args.task_id, body) ?? tokenResult({ taskId: args.task_id, status: "processing" });
      }),
  );

  // ── get_balance ────────────────────────────────────────────────────────
  server.registerTool(
    "get_balance",
    {
      title: "Get account balance",
      description: "Get the CaptchaSonic wallet balance (USD) and the active plan's limits for the configured API key.",
      inputSchema: {},
      outputSchema: {
        balance_usd: z.number(),
        username: z.string().optional(),
        profile_id: z.string().optional(),
        plan: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (_args, extra) =>
      run(async () => {
        requireKey();
        const body = await api.getBalance(extra.signal);
        const out = {
          balance_usd: typeof body.balance === "number" ? body.balance : 0,
          username: typeof body.username === "string" ? body.username : undefined,
          profile_id: typeof body.profile_id === "string" ? body.profile_id : undefined,
          plan: isObject(body.plan) ? body.plan : undefined,
        };
        const plan = out.plan ? `\nplan: ${String(out.plan.planType ?? out.plan.type ?? "none")}` : "";
        return ok(out, `balance: $${out.balance_usd.toFixed(4)}${plan}`);
      }),
  );

  // ── list_captcha_types ─────────────────────────────────────────────────
  server.registerTool(
    "list_captcha_types",
    {
      title: "List supported CAPTCHA types",
      description:
        "List every CAPTCHA type this server can solve, with required fields, answer format and price. No API key needed.",
      inputSchema: {},
      outputSchema: {
        token_types: z.array(z.record(z.string(), z.unknown())),
        image_types: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out = {
        token_types: TOKEN_TYPES.map((t) => ({
          type: t.id,
          label: t.label,
          required: t.required,
          proxy: t.apiTypeProxyless ? "optional" : "optional (recommended)",
          price_usd: t.priceUsd,
          notes: t.notes,
        })),
        image_types: IMAGE_TYPES.map((t) => ({
          type: t.id,
          label: t.label,
          required: t.required,
          answer_format: t.answerFormat,
          price: t.priceUsd,
          notes: t.notes,
        })),
      };
      const lines = [
        "Token CAPTCHAs (solve_token_captcha):",
        ...TOKEN_TYPES.map((t) => `- ${t.id}: ${t.label}. Requires ${t.required.join(", ")}.${t.notes ? " " + t.notes : ""}`),
        "",
        "Image CAPTCHAs (solve_image_captcha):",
        ...IMAGE_TYPES.map((t) => `- ${t.id}: ${t.label}. Requires ${t.required.join(", ")}.${t.notes ? " " + t.notes : ""}`),
      ];
      return ok(out, lines.join("\n"));
    },
  );

  return server;
}

// ── helpers ──────────────────────────────────────────────────────────────

const tokenResultShape = {
  task_id: z.string(),
  status: z.enum(["ready", "processing"]),
  token: z.string().optional(),
  user_agent: z.string().optional(),
  cookies: z.unknown().optional(),
  took: z.number().optional(),
};

const imageResultShape = {
  type: z.string(),
  answers: z.unknown(),
  answer_format: z.string(),
  question_type: z.string().optional(),
  size: z.unknown().optional(),
  warning: z.string().optional(),
};

async function pollTask(api: SonicApi, taskId: string, deadline: number, extra: ToolExtra): Promise<CallToolResult> {
  const progressToken = extra._meta?.progressToken;
  const started = Date.now();
  for (let i = 1; ; i++) {
    await sleep(POLL_INTERVAL_MS, extra.signal);
    const body = await api.getTaskResult(taskId, extra.signal);
    const result = interpretTaskResult(taskId, body);
    if (result) return result;
    if (Date.now() >= deadline) {
      return tokenResult({ taskId, status: "processing" });
    }
    if (progressToken !== undefined) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      await extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: i, message: `Solving… ${elapsed}s` },
        })
        .catch(() => {});
    }
  }
}

/** Returns a final result (ready or thrown error), or undefined while still pending. */
function interpretTaskResult(taskId: string, body: Record<string, unknown>): CallToolResult | undefined {
  if (body.errorId === 1) {
    throw new SonicApiError(
      String(body.errorCode ?? "ERROR"),
      String(body.errorDescription ?? "Task failed"),
      body.errorCode === "ERROR_TASK_NOT_FOUND"
        ? "The task id is unknown, belongs to another key, or has expired."
        : "Load a fresh challenge and try again. Failed solves are refunded.",
    );
  }
  if (body.status === "expired") {
    throw new SonicApiError(
      "ERROR_CAPTCHA_TIMEOUT",
      "The task was not solved within its timeout.",
      "You were refunded. Try again, or use a proxy close to the target site.",
    );
  }
  if (body.status !== "ready") return undefined;
  const solution = isObject(body.solution) ? body.solution : {};
  return tokenResult({
    taskId,
    status: "ready",
    token: typeof solution.token === "string" ? solution.token : undefined,
    userAgent: typeof solution.userAgent === "string" ? solution.userAgent : undefined,
    cookies: solution.cookies,
    took: typeof body.took === "number" ? body.took : undefined,
  });
}

function tokenResult(r: {
  taskId: string;
  status: "ready" | "processing";
  token?: string;
  userAgent?: string;
  cookies?: unknown;
  took?: number;
}): CallToolResult {
  const out = {
    task_id: r.taskId,
    status: r.status,
    token: r.token,
    user_agent: r.userAgent,
    cookies: r.cookies,
    took: r.took,
  };
  const text =
    r.status === "processing"
      ? `Task ${r.taskId} is still solving. Call get_task_result with this task_id in a few seconds.`
      : [
          `Solved. token: ${r.token ?? "(none)"}`,
          r.userAgent ? `user_agent: ${r.userAgent}` : "",
          r.cookies ? `cookies: ${JSON.stringify(r.cookies)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
  return ok(out, text);
}

function assertRequired(required: Field[], args: Record<string, unknown>, type: string): void {
  const missing = required.filter((f) => {
    const v = args[f];
    return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) {
    throw new SonicApiError(
      "ERROR_MISSING_REQUIRED_FIELDS",
      `${type} requires: ${missing.join(", ")}.`,
      "See list_captcha_types for each type's fields.",
    );
  }
}

function ok(structured: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: stripUndefined(structured) };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const text =
      err instanceof SonicApiError ? err.toAgentText() : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
