/**
 * Catalog of CAPTCHA types exposed to AI agents.
 *
 * Friendly ids (what agents send) map to the task type strings the
 * CaptchaSonic REST API accepts. The API matches type strings
 * case-insensitively. Required fields mirror the server-side validator and
 * solvers, so bad calls are rejected here, before anything is billed.
 */

export type Field =
  | "website_url"
  | "website_key"
  | "images"
  | "question"
  | "examples";

export interface TokenCaptchaType {
  id: string;
  label: string;
  /** Task type used when a proxy is supplied. */
  apiType: string;
  /** Task type used without a proxy; null when the type has no proxyless variant. */
  apiTypeProxyless: string | null;
  required: Field[];
  priceUsd: number;
  notes?: string;
}

export interface ImageCaptchaType {
  id: string;
  label: string;
  apiType: string;
  required: Field[];
  /** How to read `answers` in the result. */
  answerFormat: string;
  priceUsd: string;
  notes?: string;
}

export const TOKEN_TYPES: TokenCaptchaType[] = [
  {
    id: "recaptcha_v2",
    label: "reCAPTCHA v2 (checkbox / invisible)",
    apiType: "RecaptchaV2Task",
    apiTypeProxyless: "RecaptchaV2TaskProxyless",
    required: ["website_url", "website_key"],
    priceUsd: 0.0005,
  },
  {
    id: "recaptcha_v3",
    label: "reCAPTCHA v3",
    apiType: "RecaptchaV3Task",
    apiTypeProxyless: "RecaptchaV3TaskProxyless",
    required: ["website_url", "website_key"],
    priceUsd: 0.001,
  },
  {
    id: "turnstile",
    label: "Cloudflare Turnstile",
    apiType: "AntiTurnstileTask",
    apiTypeProxyless: "AntiTurnstileTaskProxyless",
    required: ["website_url"],
    priceUsd: 0.0005,
    notes: "website_key (the Turnstile sitekey) is optional but recommended.",
  },
  {
    id: "cloudflare_challenge",
    label: "Cloudflare challenge page (cf_clearance)",
    apiType: "AntiCloudflareTask",
    apiTypeProxyless: null,
    required: ["website_url"],
    priceUsd: 0.0005,
    notes: "Returns cookies (cf_clearance) and the userAgent to reuse. Use the same proxy for follow-up requests.",
  },
  {
    id: "popularcaptcha",
    label: "PopularCaptcha / hCaptcha-style token",
    apiType: "PopularTask",
    apiTypeProxyless: "PopularTaskProxyless",
    required: ["website_url", "website_key"],
    priceUsd: 0.0025,
    notes: "Enterprise pages: pass rqdata inside metadata.",
  },
  {
    id: "geetest",
    label: "GeeTest v3 / v4",
    apiType: "GeetestTask",
    apiTypeProxyless: "GeetestTaskProxyless",
    required: ["website_url", "website_key"],
    priceUsd: 0.0005,
    notes: "website_key is the captchaId (v4) or gt (v3). For v3 pass { gt, challenge } inside metadata.",
  },
  {
    id: "mtcaptcha",
    label: "MTCaptcha",
    apiType: "MtCaptchaTask",
    apiTypeProxyless: "MtCaptchaTaskProxyless",
    required: ["website_url", "website_key"],
    priceUsd: 0.0005,
  },
];

export const IMAGE_TYPES: ImageCaptchaType[] = [
  {
    id: "popularcaptcha_image",
    label: "PopularCaptcha / hCaptcha image challenge",
    apiType: "PopularCaptchaImage",
    required: ["images", "question"],
    answerFormat:
      "objectClassify/grid/objectTag: boolean per image. objectClick/bbox: list of {x,y} points per image. objectDrag: list of {start,end} per image.",
    priceUsd: "$0.0002 per 9 images (classify) or per image (click/drag)",
    notes: "Set question_type when known (objectClassify, objectClick, objectDrag, objectTag, grid, bbox, bboxdd).",
  },
  {
    id: "recaptcha_v2_image",
    label: "reCAPTCHA v2 image grid",
    apiType: "RecaptchaV2Classification",
    required: ["images", "question"],
    answerFormat:
      "One 300x300 (3x3) or 450x450 (4x4) grid image: 0-based indices of matching tiles. Several 100x100 tiles: boolean per tile.",
    priceUsd: "$0.0002 per request",
    notes: "question is the target text (e.g. 'traffic lights') or a class code like /m/015qff.",
  },
  {
    id: "geetest_image",
    label: "GeeTest image (nine-grid, click, slide, match)",
    apiType: "GeetestClassification",
    required: ["images", "question"],
    answerFormat:
      "nine: boolean per cell. click: click coordinates. slide: [x, y] offset. match: [index1, index2].",
    priceUsd: "$0.0006 per request",
    notes: "Prefix question with the subtype: 'geetest_nine:<prompt>', 'geetest_click:<prompt>', 'geetest_slide'. Slide puzzles need the piece in examples.",
  },
  {
    id: "aws_waf_image",
    label: "AWS WAF image grid",
    apiType: "AwsWafClassification",
    required: ["images", "question"],
    answerFormat: "0-based indices of matching tiles.",
    priceUsd: "$0.0002 per 9 images",
    notes: "question like 'Choose all the chairs' or 'grid:chairs'.",
  },
  {
    id: "tiktok_image",
    label: "TikTok (whirl, slide, click)",
    apiType: "TikTokClassification",
    required: ["images", "question"],
    answerFormat: "Solver answer object wrapped in a one-element list.",
    priceUsd: "$0.0002 per request",
    notes: "question is 'tiktok_whirl', 'tiktok_slide' or 'tiktok_click'. whirl and slide require the inner piece in examples.",
  },
  {
    id: "binance_image",
    label: "Binance (grid, slide)",
    apiType: "BinanceImage",
    required: ["images", "question"],
    answerFormat: "grid: matching tiles. slide: [x, y] offset.",
    priceUsd: "$0.0002 per request",
    notes: "question is 'binance_grid:<target>' or 'binance_slide'. Slide needs the piece in examples.",
  },
  {
    id: "tencent_image",
    label: "Tencent (grid, click, slide)",
    apiType: "TencentClassification",
    required: ["images"],
    answerFormat: "grid/click: {sol: [[x,y]...], size}. slide: [x, y] with size [w, h].",
    priceUsd: "$0.0002 per image",
    notes: "question is 'tencent_grid:<target>', 'tencent_click' (needs examples) or 'tencent_slide' (default).",
  },
  {
    id: "prosopo_image",
    label: "Prosopo / Procaptcha image",
    apiType: "ProsopoClassification",
    required: ["images", "question"],
    answerFormat: "Solver answer for the grid.",
    priceUsd: "$0.0002 per image",
  },
  {
    id: "slide_image",
    label: "Generic slider puzzle",
    apiType: "SlideImage",
    required: ["images"],
    answerFormat: "[x, y] target offset in pixels, plus the image size.",
    priceUsd: "$0.0002 per image",
    notes: "images[0] is the background; the puzzle piece is images[1] or examples[0].",
  },
  {
    id: "ocr",
    label: "Text / OCR image",
    apiType: "ImageToTextTask",
    required: ["images"],
    answerFormat: "One recognized string per image, in order.",
    priceUsd: "$0.0002 per image",
    notes: "Optional: module (e.g. 'common', 'bls'), numeric, case_sensitive, max_length.",
  },
  {
    id: "mtcaptcha_image",
    label: "MTCaptcha text image",
    apiType: "MtCaptchaClassification",
    required: ["images"],
    answerFormat: "One recognized string per image.",
    priceUsd: "$0.0002 per image",
  },
  {
    id: "audio",
    label: "Audio challenge (speech to text)",
    apiType: "AudioTask",
    required: ["images"],
    answerFormat: "Transcribed text.",
    priceUsd: "$0.0002 per request",
    notes: "Pass the audio file (base64 or URL) as the single entry in images.",
  },
];

export const TOKEN_TYPE_IDS = TOKEN_TYPES.map((t) => t.id) as [string, ...string[]];
export const IMAGE_TYPE_IDS = IMAGE_TYPES.map((t) => t.id) as [string, ...string[]];

export function tokenType(id: string): TokenCaptchaType | undefined {
  return TOKEN_TYPES.find((t) => t.id === id);
}

export function imageType(id: string): ImageCaptchaType | undefined {
  return IMAGE_TYPES.find((t) => t.id === id);
}
