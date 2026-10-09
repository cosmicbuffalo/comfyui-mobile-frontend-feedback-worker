interface RateLimit {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  GITHUB_PAT: string;
  GITHUB_REPO: string;
  RESEND_API_KEY: string;
  NOTIFY_EMAIL: string;
  FROM_EMAIL: string;
  RATE_LIMITER: RateLimit;
  STATUS_RATE_LIMITER: RateLimit;
  FEEDBACK_KV: KVNamespace;
}

interface FeedbackPayload {
  title?: unknown;
  body?: unknown;
  contact?: unknown;
  diagnostics?: unknown;
  // true asks for a reply secret so the submitter can follow the issue.
  follow?: unknown;
  // Honeypot — must be empty/absent. Bots that auto-fill all visible fields
  // will trip this and get rejected without giving them a useful error.
  website?: unknown;
}

const MAX_TITLE_LEN = 200;
const MIN_BODY_LEN = 10;
const MAX_BODY_LEN = 8000;
const MAX_CONTACT_LEN = 200;
const MAX_DIAGNOSTICS_LEN = 4000;
const MAX_SECRET_LEN = 100;
const MAX_STATUS_ISSUES = 20;
const STATUS_CACHE_SECONDS = 300;

// We intentionally allow any origin. ComfyUI users run the mobile frontend on
// arbitrary hostnames (LAN IPs, tunnels, custom DNS), so an allowlist is
// impractical. Real abuse protection lives in the rate limit, the honeypot,
// and the PAT being scoped to a single repo's issues. CORS is a browser-side
// guard anyway, easily bypassed by a server-side caller.
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  });
}

function githubHeaders(env: Env): Record<string, string> {
  return {
    'Authorization': `Bearer ${env.GITHUB_PAT}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'comfyui-mobile-frontend-feedback-worker',
  };
}

// GitHub username rules: 1–39 chars, alphanumeric or hyphens, can't start
// or end with a hyphen, can't have consecutive hyphens.
const GITHUB_HANDLE_REGEX = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

// Loose email check — anything user-provided that has a single @ with text on
// both sides and a dot in the domain. Good enough to decide between "send via
// email" and "leave as plain text in the issue body".
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function resolveGithubHandle(contact: string, env: Env): Promise<string | null> {
  const candidate = (contact.startsWith('@') ? contact.slice(1) : contact).trim();
  if (!candidate || candidate.includes('@') || /\s/.test(candidate)) return null;
  if (!GITHUB_HANDLE_REGEX.test(candidate)) return null;

  try {
    const res = await fetch(`https://api.github.com/users/${candidate}`, {
      headers: githubHeaders(env),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { login?: string };
    return typeof data.login === 'string' ? data.login : null;
  } catch {
    return null;
  }
}

async function createGithubIssue(
  env: Env,
  title: string,
  body: string,
): Promise<{ html_url: string; number: number } | null> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      body,
      labels: ['feedback'],
    }),
  });
  if (!res.ok) {
    console.error('GitHub issue create failed', res.status, await res.text());
    return null;
  }
  return (await res.json()) as { html_url: string; number: number };
}

async function sendContactEmail(
  env: Env,
  contact: string,
  issue: { html_url: string; number: number },
  title: string,
  body: string,
): Promise<void> {
  const isReplyableEmail = EMAIL_REGEX.test(contact);
  const subject = `[feedback #${issue.number}] ${title}`;
  const text = [
    `New feedback. Submitter contact: ${contact}`,
    '',
    body,
    '',
    '--',
    `Issue: ${issue.html_url}`,
    '',
    isReplyableEmail
      ? `Replying to this email goes directly to ${contact}.`
      : "The contact above isn't an email; you'll need another channel to reach the submitter.",
  ].join('\n');

  const payload: Record<string, unknown> = {
    from: env.FROM_EMAIL,
    to: [env.NOTIFY_EMAIL],
    subject,
    text,
  };
  if (isReplyableEmail) {
    payload.reply_to = [contact];
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('resend send failed', res.status, await res.text());
    }
  } catch (err) {
    console.error('resend send threw', err);
  }
}

function sanitizeString(value: unknown, maxLen: number, minLen = 1): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) return null;
  return trimmed;
}

function composeIssueBody(
  description: string,
  validatedHandle: string | null,
  contactSentPrivately: boolean,
  diagnostics: string | null,
): string {
  const parts: string[] = [
    '> [!NOTE]',
    '> Submitted through the comfyui-mobile-frontend in-app feedback tool.',
    '',
    description,
  ];
  if (validatedHandle) {
    parts.push('', '---', '', `cc @${validatedHandle}`);
  } else if (contactSentPrivately) {
    parts.push('', '---', '', '**Contact:** _sent privately to the maintainer_');
  }
  if (diagnostics) {
    parts.push(
      '',
      '---',
      '',
      '<details><summary>Diagnostics (provided by submitter)</summary>',
      '',
      diagnostics,
      '',
      '</details>',
    );
  }
  return parts.join('\n');
}

// --- Following an issue ---
//
// A submitter who asks to follow their issue gets a random secret back. Only
// its hash is kept, in KV under the issue number, so the worker can later
// confirm "whoever filed #n is asking" without knowing anything about them.
// The secret gates replies and forgetting; status needs only a followed issue
// number, since the issue itself is public.

function followKey(issueNumber: number): string {
  return `follow:${issueNumber}`;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function secretMatches(env: Env, issueNumber: number, secret: string): Promise<boolean> {
  const stored = await env.FEEDBACK_KV.get(followKey(issueNumber));
  return stored !== null && stored === (await sha256Hex(secret));
}

function parseIssueNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

interface IssueStatus {
  number: number;
  state: 'open' | 'closed';
  locked: boolean;
  // Latest time someone other than the bot commented, or the issue was
  // closed. Null when nothing has happened since it was filed.
  activityAt: string | null;
}

interface GithubIssue {
  number: number;
  state: 'open' | 'closed';
  locked: boolean;
  closed_at: string | null;
  comments: number;
  user: { login: string } | null;
}

interface GithubComment {
  created_at: string;
  user: { login: string } | null;
}

async function fetchGithubIssue(env: Env, issueNumber: number): Promise<GithubIssue | null> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`, {
    headers: githubHeaders(env),
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`GitHub issue fetch failed: ${res.status}`);
  return (await res.json()) as GithubIssue;
}

async function fetchIssueStatus(env: Env, issueNumber: number): Promise<IssueStatus | null> {
  const issue = await fetchGithubIssue(env, issueNumber);
  if (!issue) return null;
  // The bot files the issue and posts the submitter's replies, so anything
  // authored by someone else is activity the submitter hasn't seen.
  const bot = issue.user?.login;
  let activityAt = issue.closed_at;
  if (issue.comments > 0) {
    // Only the last page: feedback threads rarely pass 100 comments, and the
    // newest foreign comment is what decides the banner.
    const page = Math.ceil(issue.comments / 100);
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      { headers: githubHeaders(env) },
    );
    if (!res.ok) throw new Error(`GitHub comments fetch failed: ${res.status}`);
    for (const comment of (await res.json()) as GithubComment[]) {
      if (comment.user?.login === bot) continue;
      if (!activityAt || comment.created_at > activityAt) activityAt = comment.created_at;
    }
  }
  return { number: issue.number, state: issue.state, locked: issue.locked, activityAt };
}

// Every open app polls, so cache each issue's status at the edge rather than
// spending a GitHub request per client per check.
async function cachedIssueStatus(env: Env, issueNumber: number): Promise<IssueStatus | null> {
  const cache = caches.default;
  const key = new Request(`https://feedback-status.cache/${env.GITHUB_REPO}/${issueNumber}`);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as IssueStatus | null;
  const status = await fetchIssueStatus(env, issueNumber);
  await cache.put(key, new Response(JSON.stringify(status), {
    headers: { 'Cache-Control': `max-age=${STATUS_CACHE_SECONDS}` },
  }));
  return status;
}

async function handleStatus(url: URL, env: Env, cors: Record<string, string>): Promise<Response> {
  const numbers = [...new Set(
    (url.searchParams.get('issues') ?? '')
      .split(',')
      .map((part) => parseIssueNumber(Number(part)))
      .filter((n): n is number => n !== null),
  )];
  if (numbers.length === 0 || numbers.length > MAX_STATUS_ISSUES) {
    return jsonResponse({ error: 'invalid_fields' }, 400, cors);
  }

  const issues: IssueStatus[] = [];
  // Not followed (forgotten, or never asked for) or deleted on GitHub. The
  // app stops following these.
  const unknown: number[] = [];
  try {
    for (const n of numbers) {
      const status = (await env.FEEDBACK_KV.get(followKey(n))) === null ? null : await cachedIssueStatus(env, n);
      if (status) issues.push(status);
      else unknown.push(n);
    }
  } catch (err) {
    console.error('status lookup failed', err);
    return jsonResponse({ error: 'github_unavailable' }, 502, cors);
  }
  return jsonResponse({ issues, unknown }, 200, cors);
}

interface ReplyPayload {
  number?: unknown;
  secret?: unknown;
  body?: unknown;
  website?: unknown;
}

function composeReplyBody(body: string): string {
  return [
    '> [!NOTE]',
    '> Reply from the original submitter, sent through the in-app feedback tool.',
    '',
    body,
  ].join('\n');
}

async function handleReply(payload: ReplyPayload, env: Env, cors: Record<string, string>): Promise<Response> {
  if (typeof payload.website === 'string' && payload.website.trim().length > 0) {
    return jsonResponse({ error: 'invalid_fields' }, 400, cors);
  }
  const issueNumber = parseIssueNumber(payload.number);
  const secret = sanitizeString(payload.secret, MAX_SECRET_LEN);
  const body = sanitizeString(payload.body, MAX_BODY_LEN, MIN_BODY_LEN);
  if (!issueNumber || !secret || !body) {
    return jsonResponse({ error: 'invalid_fields' }, 400, cors);
  }
  if (!(await secretMatches(env, issueNumber, secret))) {
    return jsonResponse({ error: 'not_following' }, 403, cors);
  }

  let issue: GithubIssue | null;
  try {
    issue = await fetchGithubIssue(env, issueNumber);
  } catch (err) {
    console.error('reply issue lookup failed', err);
    return jsonResponse({ error: 'github_unavailable' }, 502, cors);
  }
  if (!issue) return jsonResponse({ error: 'not_following' }, 403, cors);
  if (issue.locked) return jsonResponse({ error: 'issue_locked' }, 409, cors);

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: composeReplyBody(body) }),
  });
  if (!res.ok) {
    console.error('GitHub comment create failed', res.status, await res.text());
    return jsonResponse({ error: 'github_create_failed' }, 502, cors);
  }
  const comment = (await res.json()) as { html_url: string };
  return jsonResponse({ url: comment.html_url }, 200, cors);
}

async function handleForget(payload: ReplyPayload, env: Env, cors: Record<string, string>): Promise<Response> {
  const issueNumber = parseIssueNumber(payload.number);
  const secret = sanitizeString(payload.secret, MAX_SECRET_LEN);
  if (!issueNumber || !secret) {
    return jsonResponse({ error: 'invalid_fields' }, 400, cors);
  }
  if (!(await secretMatches(env, issueNumber, secret))) {
    return jsonResponse({ error: 'not_following' }, 403, cors);
  }
  await env.FEEDBACK_KV.delete(followKey(issueNumber));
  return jsonResponse({ ok: true }, 200, cors);
}

async function handleSubmit(
  payload: FeedbackPayload,
  env: Env,
  ctx: ExecutionContext,
  cors: Record<string, string>,
): Promise<Response> {
  // Honeypot: any value here means a bot filled a hidden field.
  if (typeof payload.website === 'string' && payload.website.trim().length > 0) {
    return jsonResponse({ error: 'invalid_fields' }, 400, cors);
  }

  const title = sanitizeString(payload.title, MAX_TITLE_LEN);
  const body = sanitizeString(payload.body, MAX_BODY_LEN, MIN_BODY_LEN);
  if (!title || !body) {
    return jsonResponse({ error: 'invalid_fields' }, 400, cors);
  }

  const contact = payload.contact != null ? sanitizeString(payload.contact, MAX_CONTACT_LEN) : null;
  const diagnostics = payload.diagnostics != null
    ? sanitizeString(payload.diagnostics, MAX_DIAGNOSTICS_LEN)
    : null;

  const validatedHandle = contact ? await resolveGithubHandle(contact, env) : null;
  // Anything the submitter typed that isn't a verified GitHub handle is treated
  // as private — emails, phone numbers, random text all get redacted from the
  // public issue body and forwarded to the maintainer's inbox instead.
  const contactSentPrivately = !!contact && !validatedHandle;

  const issue = await createGithubIssue(
    env,
    title,
    composeIssueBody(body, validatedHandle, contactSentPrivately, diagnostics),
  );
  if (!issue) {
    return jsonResponse({ error: 'github_create_failed' }, 502, cors);
  }

  if (contactSentPrivately && contact) {
    // Fire-and-forget — don't block the response on the email send. Failures
    // are logged via the resend helper so we can spot them in `wrangler tail`.
    ctx.waitUntil(sendContactEmail(env, contact, issue, title, body));
  }

  let secret: string | undefined;
  if (payload.follow === true) {
    // The issue already exists, so a KV failure only costs the follow.
    try {
      const candidate = randomSecret();
      await env.FEEDBACK_KV.put(followKey(issue.number), await sha256Hex(candidate));
      secret = candidate;
    } catch (err) {
      console.error('follow store failed', err);
    }
  }

  return jsonResponse({ url: issue.html_url, number: issue.number, secret }, 200, cors);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const route = `${request.method} ${url.pathname}`;
    const routes = ['POST /feedback', 'POST /feedback/reply', 'POST /feedback/forget', 'GET /feedback/status'];
    if (!routes.includes(route)) {
      return jsonResponse({ error: 'not_found' }, 404, cors);
    }

    // Submitting and replying post to GitHub, so they share the strict
    // limit. Status checks and forgetting happen on their own as the app
    // runs, so they get a looser one.
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const strict = route === 'POST /feedback' || route === 'POST /feedback/reply';
    const rl = await (strict ? env.RATE_LIMITER : env.STATUS_RATE_LIMITER).limit({ key: ip });
    if (!rl.success) {
      return jsonResponse({ error: 'rate_limited' }, 429, cors);
    }

    if (route === 'GET /feedback/status') {
      return handleStatus(url, env, cors);
    }

    let payload: FeedbackPayload & ReplyPayload;
    try {
      payload = (await request.json()) as FeedbackPayload & ReplyPayload;
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, cors);
    }
    if (typeof payload !== 'object' || payload === null) {
      return jsonResponse({ error: 'invalid_json' }, 400, cors);
    }

    if (route === 'POST /feedback/reply') return handleReply(payload, env, cors);
    if (route === 'POST /feedback/forget') return handleForget(payload, env, cors);
    return handleSubmit(payload, env, ctx, cors);
  },
};
