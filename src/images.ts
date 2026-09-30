/**
 * Turns agent-supplied images (base64, data: URLs, or http(s) URLs) into the
 * raw base64 strings the solving API expects.
 *
 * The API never fetches URLs itself, and several of its local decoders do not
 * strip "data:" prefixes, so everything is normalized here.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SonicApiError } from "./api.js";

/** API limit is 7,000,000 base64 chars per image (~5 MB of bytes). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * The API host rejects request bodies over 8 MB (nginx client_max_body_size), so
 * all images and examples together must stay under that, as base64.
 */
export const MAX_TOTAL_BASE64_CHARS = 7_800_000;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

export interface ImageOptions {
  /** Allow http(s) URLs to be downloaded. */
  allowUrls: boolean;
  fetch?: typeof fetch;
}

export async function normalizeImages(inputs: string[], opts: ImageOptions, signal?: AbortSignal): Promise<string[]> {
  return Promise.all(inputs.map((input, i) => normalizeImage(input, i, opts, signal)));
}

/** Throws if the combined base64 payload would exceed the API's request size limit. */
export function assertTotalSize(...groups: (string[] | undefined)[]): void {
  const total = groups.flat().reduce((n, img) => n + (img?.length ?? 0), 0);
  if (total > MAX_TOTAL_BASE64_CHARS) {
    const mb = (total / 1_000_000).toFixed(1);
    throw new SonicApiError(
      "ERROR_TOO_BIG_CAPTCHA_FILESIZE",
      `All images together are ${mb} MB as base64; the limit is about 7.8 MB per request.`,
      "Crop the images to the challenge area, compress them, or send fewer per call.",
    );
  }
}

async function normalizeImage(input: string, index: number, opts: ImageOptions, signal?: AbortSignal): Promise<string> {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    if (!opts.allowUrls) {
      throw new SonicApiError("ERROR_BAD_PARAMETERS", `Image ${index}: URLs are not accepted here; send base64.`);
    }
    return fetchAsBase64(value, index, opts.fetch ?? fetch, signal);
  }
  const b64 = value.replace(/^data:[^;,]*;base64,/i, "").replace(/\s+/g, "");
  if (b64 === "" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) {
    throw new SonicApiError(
      "ERROR_BAD_PARAMETERS",
      `Image ${index} is not valid base64 or an http(s) URL.`,
      "Send raw base64, a data: URL, or a public image URL.",
    );
  }
  if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES) {
    throw new SonicApiError("ERROR_TOO_BIG_CAPTCHA_FILESIZE", `Image ${index} is larger than 5 MB.`, "Crop or compress it.");
  }
  return b64;
}

async function fetchAsBase64(url: string, index: number, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  let current = new URL(url);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current, index);
    let res: Response;
    try {
      res = await fetchImpl(current, { redirect: "manual", signal: combined, headers: { Accept: "image/*,audio/*" } });
    } catch {
      throw new SonicApiError("ERROR_IMAGE_FETCH", `Image ${index}: could not download ${current.origin}.`, "Send the image as base64 instead.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current);
      continue;
    }
    if (!res.ok) {
      throw new SonicApiError("ERROR_IMAGE_FETCH", `Image ${index}: download failed with HTTP ${res.status}.`, "Send the image as base64 instead.");
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/^(image|audio)\//i.test(type) && !/octet-stream/i.test(type)) {
      throw new SonicApiError("ERROR_IMAGE_FETCH", `Image ${index}: URL did not return an image (content-type "${type}").`);
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) {
      throw new SonicApiError("ERROR_TOO_BIG_CAPTCHA_FILESIZE", `Image ${index} is larger than 5 MB.`);
    }
    return Buffer.from(await readLimited(res, index)).toString("base64");
  }
  throw new SonicApiError("ERROR_IMAGE_FETCH", `Image ${index}: too many redirects.`);
}

async function readLimited(res: Response, index: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new SonicApiError("ERROR_TOO_BIG_CAPTCHA_FILESIZE", `Image ${index} is larger than 5 MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * SSRF guard: refuse hosts that resolve to loopback, private, link-local,
 * CGNAT, multicast or otherwise reserved addresses. The hosted server runs next
 * to internal services, so this matters there.
 *
 * Known limit: the address is checked, then fetch resolves again (DNS rebinding
 * window). Acceptable because responses must still be images under 5 MB.
 */
async function assertPublicHost(url: URL, index: number): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SonicApiError("ERROR_IMAGE_FETCH", `Image ${index}: only http(s) URLs are allowed.`);
  }
  if (url.username || url.password) {
    throw new SonicApiError("ERROR_IMAGE_FETCH", `Image ${index}: URLs with credentials are not allowed.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw new SonicApiError("ERROR_IMAGE_FETCH", `Image ${index}: cannot resolve ${host}.`);
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new SonicApiError("ERROR_IMAGE_FETCH", `Image ${index}: ${host} is not a public address.`);
  }
}

export function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return isBlockedV4(addr);
  if (v !== 6) return true;
  const a = addr.toLowerCase();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  if (a === "::" || a === "::1") return true;
  const first = parseInt(a.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    a.startsWith("64:ff9b:") || // NAT64
    a.startsWith("2001:db8:") // documentation
  );
}

function isBlockedV4(addr: string): boolean {
  const [a, b] = addr.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}
