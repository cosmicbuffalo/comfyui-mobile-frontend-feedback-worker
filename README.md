# comfyui-mobile-frontend-feedback-worker

Cloudflare Worker that accepts feedback submissions from [comfyui-mobile-frontend](https://github.com/cosmicbuffalo/comfyui-mobile-frontend) and creates GitHub issues on its behalf, so end users don't need a GitHub account to report bugs or request features.

## Flow

```
mobile app -> POST /feedback (form data + honeypot field)
           -> per-IP rate limit (3 / min)
           -> reject if honeypot is filled
           -> validate fields (title, body min length)
           -> if `contact` looks like a GitHub handle, GET /users/<name> to confirm
              and use as a `cc @handle` mention; otherwise pass through verbatim
           -> POST to GitHub Issues API with PAT
           -> return { url, number }
```

A note on the contact field: if a submitter provides a string that resolves to a real GitHub user (with or without a leading `@`), the worker writes `cc @handle` into the issue body, which subscribes that user to the issue. This is the same trust model GitHub itself uses for `@-mentions` — anyone can mention anyone. If abuse becomes a problem, drop the `cc @` line in `composeIssueBody` and treat all contacts as plain text.

Anti-abuse layers (intentionally light, since the PAT is scoped to a single repo's issues):
- Per-IP rate limiting
- Honeypot field (`website`) — bots that auto-fill all visible fields trip it
- Body min length

If abuse becomes a problem in practice, swap in Turnstile (the previous version of this worker had it; see git history for reference).

## First-time setup

1. `npm install`
2. `npx wrangler login` — opens browser, authorizes wrangler against your Cloudflare account.
3. Set the production GitHub PAT:
   ```
   npx wrangler secret put GITHUB_PAT
   ```
4. `npx wrangler deploy` — deploys to `comfyui-mobile-frontend-feedback.<your-subdomain>.workers.dev`.
5. Bind a custom route. In the Cloudflare dashboard:
   - Go to **Workers & Pages** -> the `comfyui-mobile-frontend-feedback` worker -> **Settings** -> **Domains & Routes**
   - Add a **Custom Domain**: `feedback.comfyui-mobile-frontend.com`
   - CF will provision the DNS record automatically since the domain is on your account.
6. Update the frontend's `VITE_FEEDBACK_ENDPOINT` to `https://feedback.comfyui-mobile-frontend.com/feedback`.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill in `GITHUB_PAT` (your real PAT — it'll create real issues, so consider pointing `GITHUB_REPO` in `wrangler.toml` at a sandbox repo while iterating).
2. `npm run dev` — wrangler dev server on `http://localhost:8787`.
3. Test with:
   ```
   curl -X POST http://localhost:8787/feedback \
     -H "Origin: http://localhost:3000" \
     -H "Content-Type: application/json" \
     -d '{"title":"test","body":"test from curl - this is a real submission"}'
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
