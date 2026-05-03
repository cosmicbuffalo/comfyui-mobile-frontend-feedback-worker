interface RateLimit {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  GITHUB_PAT: string;
  TURNSTILE_SECRET: string;
  GITHUB_REPO: string;
  ALLOWED_ORIGINS: string;
  RATE_LIMITER: RateLimit;
}

interface FeedbackPayload {
  title?: unknown;
  body?: unknown;
  contact?: unknown;
  diagnostics?: unknown;
  turnstileToken?: unknown;
}

const MAX_TITLE_LEN = 200;
const MAX_BODY_LEN = 8000;
const MAX_CONTACT_LEN = 200;
const MAX_DIAGNOSTICS_LEN = 4000;

function corsHeaders(origin: string | null, allowed: Set<string>): Record<string, string> {
  const allowOrigin = origin && allowed.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
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

async function verifyTurnstile(
  token: string,
  secret: string,
  ip: string,
): Promise<boolean> {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  form.append('remoteip', ip);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

async function createGithubIssue(
  env: Env,
  title: string,
  body: string,
): Promise<{ html_url: string; number: number } | null> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'comfyui-mobile-frontend-feedback-worker',
      'Content-Type': 'application/json',
    },
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

function sanitizeString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

function composeIssueBody(
  description: string,
  contact: string | null,
  diagnostics: string | null,
): string {
  const parts: string[] = [description];
  if (contact) {
    parts.push('', '---', '', `**Contact:** ${contact}`);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = new Set(env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST' || url.pathname !== '/feedback') {
      return jsonResponse({ error: 'not_found' }, 404, cors);
    }

    if (!origin || !allowed.has(origin)) {
      return jsonResponse({ error: 'origin_not_allowed' }, 403, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const rl = await env.RATE_LIMITER.limit({ key: ip });
    if (!rl.success) {
      return jsonResponse({ error: 'rate_limited' }, 429, cors);
    }

    let payload: FeedbackPayload;
    try {
      payload = (await request.json()) as FeedbackPayload;
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, cors);
    }

    const title = sanitizeString(payload.title, MAX_TITLE_LEN);
    const body = sanitizeString(payload.body, MAX_BODY_LEN);
    const turnstileToken = sanitizeString(payload.turnstileToken, 2048);
    if (!title || !body || !turnstileToken) {
      return jsonResponse({ error: 'invalid_fields' }, 400, cors);
    }

    const contact = payload.contact != null ? sanitizeString(payload.contact, MAX_CONTACT_LEN) : null;
    const diagnostics = payload.diagnostics != null
      ? sanitizeString(payload.diagnostics, MAX_DIAGNOSTICS_LEN)
      : null;

    const turnstileOk = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
    if (!turnstileOk) {
      return jsonResponse({ error: 'turnstile_failed' }, 403, cors);
    }

    const issue = await createGithubIssue(env, title, composeIssueBody(body, contact, diagnostics));
    if (!issue) {
      return jsonResponse({ error: 'github_create_failed' }, 502, cors);
    }

    return jsonResponse({ url: issue.html_url, number: issue.number }, 200, cors);
  },
};
