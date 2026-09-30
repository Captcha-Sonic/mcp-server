/**
 * Minimal REST client for the CaptchaSonic solving API (api.captchasonic.com).
 *
 * The REST API mixes three response shapes:
 *   - image solves:  { code: 200, answers, ... }  / errors { code: N, msg }
 *   - token tasks:   { errorId: 0, taskId, status } / errors { errorId: 1, errorCode, errorDescription }
 *   - misc failures: { status: "error", message }
 * `readError` folds all of them into one SonicApiError with an agent-actionable hint.
 */

export const DEFAULT_BASE_URL = "https://api.captchasonic.com";
export const DASHBOARD_URL = "https://my.captchasonic.com";

type Json = Record<string, unknown>;

export class SonicApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "SonicApiError";
  }

  /** Text shown to the agent. */
  toAgentText(): string {
    const parts = [`${this.code}: ${this.message}`];
    if (this.hint) parts.push(this.hint);
    if (this.retryAfterSec) parts.push(`Retry after ${this.retryAfterSec}s.`);
    return parts.join("\n");
  }
}

// Numeric codes from the billing engine error table.
const NUMERIC_CODES: Record<number, { name: string; hint?: string }> = {
  1: { name: "ERROR_KEY_DOES_NOT_EXIST", hint: `The API key is invalid or revoked. Get a key at ${DASHBOARD_URL}.` },
  3: { name: "ERROR_ZERO_CAPTCHA_FILESIZE", hint: "An image was empty. Send the image bytes as base64." },
  4: { name: "ERROR_TOO_BIG_CAPTCHA_FILESIZE", hint: "An image is larger than 5 MB. Crop or compress it." },
  10: { name: "ERROR_ZERO_BALANCE", hint: `The account has no balance. Top up at ${DASHBOARD_URL}.` },
  11: { name: "ERROR_NO_PLAN_OR_NOT_MASTER_KEY", hint: `Wallet use is disabled for this key. Check the plan at ${DASHBOARD_URL}.` },
  12: { name: "ERROR_CAPTCHA_UNSOLVABLE", hint: "The solver could not solve this challenge. Load a fresh challenge and retry once. You were not charged." },
  13: { name: "ERROR_BAD_DUPLICATES" },
  14: { name: "ERROR_NO_SUCH_METHOD" },
  17: { name: "ERROR_DAILY_LIMIT_EXCEEDED", hint: "The plan's daily limit is used up." },
  18: { name: "ERROR_QUOTA_LIMIT_EXCEEDED", hint: "The plan quota is used up." },
  19: { name: "ERROR_MINUTE_LIMIT_EXCEEDED", hint: "Too many requests this minute. Wait before retrying." },
  20: { name: "ERROR_INTERNAL_BILLING_ISSUE", hint: "Contact support@captchasonic.com." },
  21: { name: "ERROR_SERVICE_UNAVAILABLE", hint: "The service is busy. Retry in a few seconds." },
  23: { name: "ERROR_TASK_NOT_SUPPORTED", hint: "Call list_captcha_types to see supported types." },
  24: { name: "ERROR_PLAN_INACTIVE", hint: `The plan is inactive. Check ${DASHBOARD_URL}.` },
  25: { name: "ERROR_PLAN_EXPIRED", hint: `The plan has expired. Renew at ${DASHBOARD_URL}.` },
  110: { name: "ERROR_BAD_PARAMETERS", hint: "Check the required fields for this type with list_captcha_types." },
  115: { name: "ERROR_BAD_IMGINSTRUCTIONS", hint: "The question text was not understood. Pass the challenge prompt exactly as shown." },
  116: { name: "ERROR_INVALID_JSON" },
  400: {
    name: "ERROR_VIDEO_PAYLOAD_REQUIRED",
    hint: "This challenge is a video/canvas variant that needs frames, which this tool does not capture. Reload the challenge to get a static one.",
  },
};

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Returns a SonicApiError if the body describes a failure, otherwise undefined. */
export function readError(body: Json, httpStatus: number): SonicApiError | undefined {
  const code = num(body.code);
  if (code !== undefined && code !== 200) {
    const known = NUMERIC_CODES[code];
    const name = known?.name ?? `ERROR_${code}`;
    // msg is often just the error name again; only keep it when it adds information.
    const rawMsg = str(body.msg);
    const msg = rawMsg && rawMsg !== name ? rawMsg : `CaptchaSonic API error ${code}`;
    const details = str(body.details);
    // retryAfterSec only helps for limits and busy errors, not for a bad key or balance.
    const retryable = code === 17 || code === 18 || code === 19 || code === 21;
    return new SonicApiError(name, details ? `${msg} (${details})` : msg, known?.hint, retryable ? num(body.retryAfterSec) : undefined);
  }
  if (num(body.errorId) === 1) {
    const name = str(body.errorCode) ?? "ERROR";
    const desc = str(body.errorDescription) ?? str(body.msg) ?? name;
    const hint =
      name === "ERROR_TASK_NOT_FOUND"
        ? "The task id is unknown, belongs to another key, or has expired."
        : name === "ERROR_CAPTCHA_UNSOLVABLE"
          ? NUMERIC_CODES[12].hint
          : name === "ERROR_PROXY_NOT_ALLOWED"
            ? "This type is proxyless; remove the proxy."
            : undefined;
    return new SonicApiError(name, desc, hint);
  }
  if (body.status === "error") {
    return new SonicApiError("ERROR_BAD_REQUEST", str(body.message) ?? "Request rejected");
  }
  if (httpStatus >= 400) {
    return new SonicApiError(`HTTP_${httpStatus}`, `Unexpected HTTP ${httpStatus} from CaptchaSonic API`);
  }
  return undefined;
}

export interface ApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Sent as User-Agent, e.g. "captchasonic-mcp/2.0.0 (hosted)". */
  userAgent?: string;
  fetch?: typeof fetch;
}

export class SonicApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ApiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get hasKey(): boolean {
    return this.opts.apiKey.trim() !== "";
  }

  private async request(
    path: string,
    init: { method: "GET" | "POST"; body?: Json; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ status: number; body: Json }> {
    const signals = [AbortSignal.timeout(init.timeoutMs)];
    if (init.signal) signals.push(init.signal);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.opts.userAgent) headers["User-Agent"] = this.opts.userAgent;
    if (init.body) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method: init.method,
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (init.signal?.aborted) throw new SonicApiError("CANCELLED", "Request was cancelled");
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new SonicApiError(
        timedOut ? "ERROR_TIMEOUT" : "ERROR_NETWORK",
        timedOut ? "CaptchaSonic API did not respond in time" : "Could not reach the CaptchaSonic API",
        "Retry in a few seconds.",
      );
    }
    if (res.status === 413) {
      throw new SonicApiError("ERROR_TOO_BIG_CAPTCHA_FILESIZE", "The request is too large for the API.", "Send fewer or smaller images.");
    }
    let body: Json;
    try {
      body = (await res.json()) as Json;
    } catch {
      throw new SonicApiError(`HTTP_${res.status}`, `CaptchaSonic API returned a non-JSON response (HTTP ${res.status})`);
    }
    return { status: res.status, body };
  }

  /** POST /createTask. Throws SonicApiError on any API-level failure. */
  async createTask(task: Json, signal?: AbortSignal): Promise<Json> {
    // Retry only on "server busy" (code 21 / 503): the request was rejected before
    // any work or billing happened, so a retry cannot double-charge.
    for (let attempt = 0; ; attempt++) {
      const { status, body } = await this.request("/createTask", {
        method: "POST",
        body: { apiKey: this.opts.apiKey, task },
        timeoutMs: 90_000,
        signal,
      });
      const err = readError(body, status);
      if (err?.code === "ERROR_SERVICE_UNAVAILABLE" && attempt < 2) {
        await sleep(1000 * (attempt + 1), signal);
        continue;
      }
      if (err) throw err;
      return body;
    }
  }

  /** POST /getTaskResult. Returns the raw body; callers interpret status. */
  async getTaskResult(taskId: string, signal?: AbortSignal): Promise<Json> {
    // apiKey is always sent so the server enforces task ownership.
    const { status, body } = await this.request("/getTaskResult", {
      method: "POST",
      body: { apiKey: this.opts.apiKey, taskId },
      timeoutMs: 20_000,
      signal,
    });
    if (status === 400 && !body.errorCode) {
      throw new SonicApiError("ERROR_BAD_PARAMETERS", str(body.msg) ?? "taskId required");
    }
    return body;
  }

  /** GET /balance (the endpoint only accepts the key as a query parameter). */
  async getBalance(signal?: AbortSignal): Promise<Json> {
    const q = new URLSearchParams({ apiKey: this.opts.apiKey });
    const { status, body } = await this.request(`/balance?${q}`, { method: "GET", timeoutMs: 15_000, signal });
    const err = readError(body, status);
    if (err) throw err;
    return body;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SonicApiError("CANCELLED", "Request was cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new SonicApiError("CANCELLED", "Request was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
