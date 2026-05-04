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
}

interface FeedbackPayload {
  title?: unknown;
  body?: unknown;
  contact?: unknown;
  diagnostics?: unknown;
  // Honeypot — must be empty/absent. Bots that auto-fill all visible fields
  // will trip this and get rejected without giving them a useful error.
  website?: unknown;
}

const MAX_TITLE_LEN = 200;
const MIN_BODY_LEN = 10;
const MAX_BODY_LEN = 8000;
const MAX_CONTACT_LEN = 200;
const MAX_DIAGNOSTICS_LEN = 4000;

// We intentionally allow any origin. ComfyUI users run the mobile frontend on
// arbitrary hostnames (LAN IPs, tunnels, custom DNS), so an allowlist is
// impractical. Real abuse protection lives in the rate limit, the honeypot,
// and the PAT being scoped to a single repo's issues. CORS is a browser-side
// guard anyway, easily bypassed by a server-side caller.
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'comfyui-mobile-frontend-feedback-worker',
      },
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

async function sendContactEmail(
  env: Env,
  submitterEmail: string,
  issue: { html_url: string; number: number },
  title: string,
  body: string,
): Promise<void> {
  const subject = `[feedback #${issue.number}] ${title}`;
  const text = [
    `New feedback from ${submitterEmail}:`,
    '',
    body,
    '',
    '--',
    `Issue: ${issue.html_url}`,
    '',
    `Replying to this email goes directly to ${submitterEmail}.`,
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: [env.NOTIFY_EMAIL],
        reply_to: [submitterEmail],
        subject,
        text,
      }),
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
  contact: string | null,
  validatedHandle: string | null,
  contactSentPrivately: boolean,
  diagnostics: string | null,
): string {
  const parts: string[] = [description];
  if (validatedHandle) {
    parts.push('', '---', '', `cc @${validatedHandle}`);
  } else if (contactSentPrivately) {
    parts.push('', '---', '', '**Contact:** _sent privately to the maintainer_');
  } else if (contact) {
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST' || url.pathname !== '/feedback') {
      return jsonResponse({ error: 'not_found' }, 404, cors);
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
    const isEmailContact = !validatedHandle && !!contact && EMAIL_REGEX.test(contact);

    const issue = await createGithubIssue(
      env,
      title,
      composeIssueBody(body, contact, validatedHandle, isEmailContact, diagnostics),
    );
    if (!issue) {
      return jsonResponse({ error: 'github_create_failed' }, 502, cors);
    }

    if (isEmailContact && contact) {
      // Fire-and-forget — don't block the response on the email send. Failures
      // are logged via the resend helper so we can spot them in `wrangler tail`.
      ctx.waitUntil(sendContactEmail(env, contact, issue, title, body));
    }

    return jsonResponse({ url: issue.html_url, number: issue.number }, 200, cors);
  },
};
