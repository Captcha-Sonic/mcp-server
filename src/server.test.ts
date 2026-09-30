import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCaptchaSonicServer } from "./server.js";
import { isBlockedAddress } from "./images.js";

type Call = { url: string; method: string; body?: any };

/** Fake billing API: `routes` maps path → handler returning [status, body]. */
function fakeApi(routes: Record<string, (call: Call, n: number) => [number, unknown]>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { url: url.toString(), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const handler = routes[url.pathname];
    if (!handler) throw new Error(`unexpected ${url.pathname}`);
    counts[url.pathname] = (counts[url.pathname] ?? 0) + 1;
    const [status, body] = handler(call, counts[url.pathname]);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

async function connect(fetchImpl: typeof fetch, apiKey = "sonic_test_key") {
  const server = createCaptchaSonicServer({ apiKey, fetch: fetchImpl, baseUrl: "https://api.test" });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

test("lists the five tools with annotations", async () => {
  const client = await connect(fakeApi({}).impl);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["get_balance", "get_task_result", "list_captcha_types", "solve_image_captcha", "solve_token_captcha"],
  );
  assert.equal(tools.find((t) => t.name === "get_balance")!.annotations?.readOnlyHint, true);
});

test("token solve: picks proxyless type, polls with apiKey, returns token", async () => {
  const api = fakeApi({
    "/createTask": () => [200, { errorId: 0, taskId: "abc123", status: "idle" }],
    "/getTaskResult": (_c, n) =>
      n < 2
        ? [200, { errorId: 0, status: "processing", taskId: "abc123" }]
        : [200, { errorId: 0, status: "ready", solution: { token: "TOKEN", userAgent: "UA" }, took: 7, taskId: "abc123" }],
  });
  const client = await connect(api.impl);
  const r: any = await client.callTool({
    name: "solve_token_captcha",
    arguments: { type: "recaptcha_v2", website_url: "https://example.com", website_key: "6Le-xxxxxxxxxx" },
  });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.token, "TOKEN");
  assert.equal(r.structuredContent.user_agent, "UA");
  const create = api.calls[0];
  assert.equal(create.body.apiKey, "sonic_test_key");
  assert.equal(create.body.task.type, "RecaptchaV2TaskProxyless");
  assert.equal(create.body.task.websiteKey, "6Le-xxxxxxxxxx");
  for (const c of api.calls.slice(1)) assert.equal(c.body.apiKey, "sonic_test_key");
});

test("token solve: proxy switches to proxied type; wait_for_result=false returns task id", async () => {
  const api = fakeApi({ "/createTask": () => [200, { errorId: 0, taskId: "t1", status: "idle" }] });
  const client = await connect(api.impl);
  const r: any = await client.callTool({
    name: "solve_token_captcha",
    arguments: { type: "turnstile", website_url: "https://x.com", proxy: "http://u:p@1.2.3.4:80", wait_for_result: false },
  });
  assert.equal(api.calls[0].body.task.type, "AntiTurnstileTask");
  assert.deepEqual(r.structuredContent, { task_id: "t1", status: "processing" });
});

test("token solve: missing sitekey is rejected before any API call", async () => {
  const api = fakeApi({});
  const client = await connect(api.impl);
  const r: any = await client.callTool({ name: "solve_token_captcha", arguments: { type: "recaptcha_v2", website_url: "https://x.com" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /website_key/);
  assert.equal(api.calls.length, 0);
});

test("get_task_result: expired is reported as a refunded failure", async () => {
  const api = fakeApi({ "/getTaskResult": () => [200, { errorId: 0, status: "expired", taskId: "t" }] });
  const client = await connect(api.impl);
  const r: any = await client.callTool({ name: "get_task_result", arguments: { task_id: "t" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /ERROR_CAPTCHA_TIMEOUT[\s\S]*refunded/);
});

test("image solve: strips data: prefix and maps OCR options", async () => {
  const api = fakeApi({ "/createTask": () => [200, { code: 200, msg: "", answers: ["ab12"] }] });
  const client = await connect(api.impl);
  const r: any = await client.callTool({
    name: "solve_image_captcha",
    arguments: { type: "ocr", images: ["data:image/png;base64,aGVsbG8="], numeric: true, max_length: 4, case_sensitive: false },
  });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent.answers, ["ab12"]);
  const task = api.calls[0].body.task;
  assert.deepEqual(task.images, ["aGVsbG8="]);
  assert.equal(task.type, "ImageToTextTask");
  assert.equal(task.numeric, true);
  assert.equal(task.maxLength, 4);
  assert.equal(task.case, false);
});

test("image solve: numeric API errors become actionable messages", async () => {
  const api = fakeApi({ "/createTask": () => [402, { code: 10, msg: "ERROR_ZERO_BALANCE", retryAfterSec: 600 }] });
  const client = await connect(api.impl);
  const r: any = await client.callTool({
    name: "solve_image_captcha",
    arguments: { type: "aws_waf_image", images: ["aGVsbG8="], question: "Choose all the chairs" },
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /ERROR_ZERO_BALANCE[\s\S]*Top up/);
});

test("image solve: private-network URLs are refused (SSRF)", async () => {
  const api = fakeApi({});
  const client = await connect(api.impl);
  const r: any = await client.callTool({
    name: "solve_image_captcha",
    arguments: { type: "ocr", images: ["http://169.254.169.254/latest/meta-data"] },
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /not a public address/);
  assert.equal(api.calls.length, 0);
});

test("audio answers come back from the token-shaped response", async () => {
  const api = fakeApi({ "/createTask": () => [200, { errorId: 0, solution: "hello world" }] });
  const client = await connect(api.impl);
  const r: any = await client.callTool({ name: "solve_image_captcha", arguments: { type: "audio", images: ["aGVsbG8="] } });
  assert.equal(r.structuredContent.answers, "hello world");
});

test("server busy (code 21) is retried, then succeeds", async () => {
  const api = fakeApi({
    "/createTask": (_c, n) => (n === 1 ? [503, { code: 21, msg: "Server busy, try again" }] : [200, { code: 200, answers: [1, 4] }]),
  });
  const client = await connect(api.impl);
  const r: any = await client.callTool({
    name: "solve_image_captcha",
    arguments: { type: "recaptcha_v2_image", images: ["aGVsbG8="], question: "bus" },
  });
  assert.deepEqual(r.structuredContent.answers, [1, 4]);
  assert.equal(api.calls.length, 2);
});

test("get_balance returns balance and plan; invalid key is explained", async () => {
  const good = fakeApi({ "/balance": () => [200, { status: "ok", balance: 1.23456, username: "u", plan: { planType: "wallet" } }] });
  const r: any = await (await connect(good.impl)).callTool({ name: "get_balance", arguments: {} });
  assert.equal(r.structuredContent.balance_usd, 1.23456);
  assert.equal(new URL(good.calls[0].url).searchParams.get("apiKey"), "sonic_test_key");

  const bad = fakeApi({ "/balance": () => [200, { code: 1, msg: "ERROR_KEY_DOES_NOT_EXIST", retryAfterSec: 60 }] });
  const e: any = await (await connect(bad.impl)).callTool({ name: "get_balance", arguments: {} });
  assert.equal(e.isError, true);
  assert.match(text(e), /invalid or revoked/);
});

test("without an API key, solving explains how to configure one; listing still works", async () => {
  const client = await connect(fakeApi({}).impl, "");
  const r: any = await client.callTool({ name: "get_balance", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /No CaptchaSonic API key/);
  const l: any = await client.callTool({ name: "list_captcha_types", arguments: {} });
  assert.ok(l.structuredContent.token_types.length >= 7);
});

test("isBlockedAddress covers private, metadata and mapped ranges", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ["1.1.1.1", "142.250.72.14", "2606:4700::1111"]) assert.equal(isBlockedAddress(a), false, a);
});

test("oversized total payload is rejected before calling the API", async () => {
  const api = fakeApi({});
  const client = await connect(api.impl);
  const big = "A".repeat(4_000_000);
  const r: any = await client.callTool({ name: "solve_image_captcha", arguments: { type: "ocr", images: [big, big] } });
  assert.equal(r.isError, true);
  assert.match(text(r), /limit is about 7.8 MB/);
  assert.equal(api.calls.length, 0);
});
