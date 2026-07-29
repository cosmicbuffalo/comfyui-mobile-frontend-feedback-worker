# comfyui-mobile-frontend-feedback-worker

Cloudflare Worker that accepts feedback submissions from [comfyui-mobile-frontend](https://github.com/cosmicbuffalo/comfyui-mobile-frontend) and creates GitHub issues on its behalf, so end users don't need a GitHub account to report bugs or request features.

## Flow

```
mobile app -> POST /feedback (form data + honeypot field)
           -> per-IP rate limit (3 / min)
           -> reject if honeypot is filled
           -> validate fields (title, body min length)
           -> categorize `contact`:
                * verified GitHub handle (GET /users/<name> succeeds) -> cc @handle in issue
                * anything else (emails, phone numbers, random text) ->
                    redacted from issue body, forwarded to maintainer via Resend
           -> POST to GitHub Issues API with PAT
           -> if private contact: ctx.waitUntil sendContactEmail
           -> return { url, number }
```

The contact field is binary: only verified GitHub handles end up on the public issue (as a `cc @handle` mention, which subscribes that user just like any GitHub @-mention). Everything else is treated as private — emails, phone numbers, free text, anything that doesn't resolve to a real GitHub user — and gets forwarded to the maintainer's inbox via [Resend](https://resend.com), with the issue body showing `**Contact:** _sent privately to the maintainer_` so the submitter knows what to expect.

Reply-To on the email is set to the submitter when their contact looks like a valid email address; otherwise the email body says you'll need another channel to reach them.

Anti-abuse layers (intentionally light, since the PAT is scoped to a single repo's issues):
- Per-IP rate limiting
- Honeypot field (`website`) — bots that auto-fill all visible fields trip it
- Body min length

If abuse becomes a problem in practice, swap in Turnstile (the previous version of this worker had it; see git history for reference).

## First-time setup

1. `npm install`
2. `npx wrangler login` — opens browser, authorizes wrangler against your Cloudflare account.
3. Set the production secrets:
   ```
   npx wrangler secret put GITHUB_PAT       # classic PAT on the BuffaloBot account, public_repo scope
   npx wrangler secret put RESEND_API_KEY   # for emailing the maintainer on email contacts
   npx wrangler secret put NOTIFY_EMAIL     # where contact-emails get delivered
   ```
   The `FROM_EMAIL` value lives in `wrangler.toml` since it's already public via DNS.
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

The worker authenticates as the **BuffaloBot** account so issues aren't authored by
the maintainer. This must be a **classic** PAT with the `public_repo` scope, *not* a
fine-grained one: fine-grained PATs can only reach repos owned by the token's own
account, so a token owned by BuffaloBot can't touch `cosmicbuffalo/comfyui-mobile-frontend`.
A classic token acts with the account's full access, including repos it's a collaborator
on. BuffaloBot also needs at least **Triage** collaborator access on the repo, or GitHub
silently drops the `feedback` label when the issue is created.

Set a calendar reminder for whatever expiry you chose. To rotate:

1. Logged in as **BuffaloBot**, generate a new classic PAT with the `public_repo` scope.
2. `npx wrangler secret put GITHUB_PAT` — paste new value. Updates atomically; no downtime.
3. Revoke the old PAT in GitHub settings.

## Tail logs

```
npm run tail
```

Streams live request logs from production. Errors from `createGithubIssue` are logged via `console.error`.
