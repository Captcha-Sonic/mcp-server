# @captchasonic/mcp-server

MCP (Model Context Protocol) server for the [CaptchaSonic](https://captchasonic.com) CAPTCHA solving API. Lets **Claude** and any MCP-compatible AI agent solve CAPTCHAs, check balance, and verify server health.

## Quick Start

```bash
claude mcp add sonic --env SONIC_API_KEY=sonic_xxxx -- npx -y @captchasonic/mcp-server
```

Or install globally:

```bash
npm install -g @captchasonic/mcp-server
claude mcp add sonic --env SONIC_API_KEY=sonic_xxxx -- sonic-mcp
```

## Tools

| Tool | Description | Requires API Key |
|---|---|---|
| `health_check` | Check if the CaptchaSonic API is healthy | No |
| `get_balance` | Get account balance in USD | Yes |
| `solve_captcha` | Submit a CAPTCHA image for solving | Yes |

### solve_captcha

Supports all CaptchaSonic captcha types:

- **PopularCaptcha** (image grid challenges)
- **reCAPTCHA v2** (grid select)
- **Geetest** (slide, click, nine-grid)
- **AWS WAF**
- **TikTok**
- **Binance**
- **OCR** (text recognition)
- **Turnstile / Cloudflare**

```
Parameters:
  type          — CAPTCHA type (e.g. "PopularCaptchaImage", "geetest_slide", "ocr")
  question      — The challenge question (e.g. "Select all traffic lights")
  image_base64  — Base64-encoded image bytes (PNG/JPEG)
  image_url     — Public URL of the image (alternative to image_base64)
  website_url   — Page URL where the CAPTCHA appears (optional)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SONIC_API_KEY` | Your CaptchaSonic API key (`sonic_xxxx`) | — (required) |
| `SONIC_BASE_URL` | Override server URL | `https://api.captchasonic.com` |

## License

MIT — [CaptchaSonic](https://captchasonic.com)
