# comfyui-mobile-frontend-feedback-worker

Cloudflare Worker that accepts feedback submissions from [comfyui-mobile-frontend](https://github.com/cosmicbuffalo/comfyui-mobile-frontend) and creates GitHub issues on its behalf, so end users don't need a GitHub account to report bugs or request features.

## Flow

```
mobile app -> POST /feedback (Turnstile token + form data)
           -> verify origin
           -> per-IP rate limit (5 / min)
           -> verify Turnstile with CF
           -> POST to GitHub Issues API with PAT
           -> return { url, number }
```

## First-time setup

1. `npm install`
2. `npx wrangler login` — opens browser, authorizes wrangler against your Cloudflare account.
3. Set the production secrets (you will be prompted to paste each value):
   ```
   npx wrangler secret put GITHUB_PAT
   npx wrangler secret put TURNSTILE_SECRET
   ```
4. `npx wrangler deploy` — deploys to `comfyui-mobile-frontend-feedback.<your-subdomain>.workers.dev`.
5. Bind a custom route. In the Cloudflare dashboard:
   - Go to **Workers & Pages** -> the `comfyui-mobile-frontend-feedback` worker -> **Settings** -> **Triggers**
   - Add a **Custom Domain**: `feedback.comfyui-mobile-frontend.com`
   - CF will provision the DNS record automatically since the domain is on your account.
6. Update the frontend's `VITE_FEEDBACK_ENDPOINT` in `.env.production` to `https://feedback.comfyui-mobile-frontend.com/feedback`.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill in test values:
   - For `TURNSTILE_SECRET` use the always-passes test secret `1x0000000000000000000000000000000AA`.
   - For `GITHUB_PAT` use your real PAT (it'll create real issues — use a sandbox repo if you want to avoid that, by changing `GITHUB_REPO` in `wrangler.toml`).
2. `npm run dev` — wrangler dev server on `http://localhost:8787`.
3. Test with:
   ```
   curl -X POST http://localhost:8787/feedback \
     -H "Origin: http://localhost:3000" \
     -H "Content-Type: application/json" \
     -d '{"title":"test","body":"test from curl","turnstileToken":"XXXX.DUMMY.TOKEN.XXXX"}'
   ```

## Rotating the GitHub PAT

Fine-grained PATs max out at 1 year. Set a calendar reminder. To rotate:

1. Generate a new PAT with the same scope (Issues: Read+Write on `comfyui-mobile-frontend`).
2. `npx wrangler secret put GITHUB_PAT` — paste new value. Updates atomically; no downtime.
3. Revoke the old PAT in GitHub settings.

## Tail logs

```
npm run tail
```

Streams live request logs from production. Errors from `createGithubIssue` are logged via `console.error`.
