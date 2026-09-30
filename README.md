# @captchasonic/mcp-server

[CaptchaSonic](https://captchasonic.com) MCP server. Gives Claude, Cursor and any MCP client tools to solve CAPTCHAs: reCAPTCHA v2/v3, Cloudflare Turnstile and challenge pages, hCaptcha-style PopularCaptcha, GeeTest, MTCaptcha, AWS WAF, TikTok, Binance, Tencent, OCR and more.

## Use the hosted server (recommended)

No install. Point your client at `https://mcp.captchasonic.com` with your API key as a bearer token:

```bash
claude mcp add --transport http captchasonic https://mcp.captchasonic.com \
  --header "Authorization: Bearer sonic_xxx"
```

Setup for other clients: https://captchasonic.com/en/docs/mcp/get-started

## Run locally (stdio)

Use this package when your client only supports local stdio servers:

```bash
claude mcp add captchasonic --env SONIC_API_KEY=sonic_xxx -- npx -y @captchasonic/mcp-server
```

```json
{
  "mcpServers": {
    "captchasonic": {
      "command": "npx",
      "args": ["-y", "@captchasonic/mcp-server"],
      "env": { "SONIC_API_KEY": "sonic_xxx" }
    }
  }
}
```

Get an API key at [my.captchasonic.com](https://my.captchasonic.com). Requires Node.js 20.3+.

| Variable | Description | Default |
|---|---|---|
| `SONIC_API_KEY` | Your CaptchaSonic API key | (required for solving) |
| `SONIC_BASE_URL` | Solving API URL | `https://api.captchasonic.com` |

## Tools

| Tool | What it does |
|---|---|
| `solve_token_captcha` | Solves reCAPTCHA v2/v3, Turnstile, Cloudflare challenge, PopularCaptcha, GeeTest, MTCaptcha from the page URL and sitekey. Waits for the token. |
| `solve_image_captcha` | Solves image grids, sliders, click challenges, OCR and audio from images (base64 or URL). Returns the answer immediately. |
| `get_task_result` | Fetches a token task result by id (for clients that stop waiting early). |
| `get_balance` | Wallet balance and plan limits. |
| `list_captcha_types` | Every supported type with required fields, answer format and price. |

## Use as a library

The hosted server is built on the same factory:

```ts
import { createCaptchaSonicServer } from "@captchasonic/mcp-server";

const server = createCaptchaSonicServer({ apiKey: "sonic_xxx", mode: "my-app" });
```

## License

MIT
