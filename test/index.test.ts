import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const BOT = 'BuffaloBot';

function makeEnv() {
  const kv = new Map<string, string>();
  const meta = new Map<string, unknown>();
  return {
    kv,
    env: {
      GITHUB_PAT: 'pat',
      GITHUB_REPO: 'owner/repo',
      RESEND_API_KEY: '',
      NOTIFY_EMAIL: '',
      FROM_EMAIL: '',
      RATE_LIMITER: { limit: async () => ({ success: true }) },
      STATUS_RATE_LIMITER: { limit: async () => ({ success: true }) },
      FEEDBACK_KV: {
        get: async (key: string) => kv.get(key) ?? null,
        getWithMetadata: async (key: string) => ({ value: kv.get(key) ?? null, metadata: meta.get(key) ?? null }),
        put: async (key: string, value: string, options?: { metadata?: unknown }) => {
          kv.set(key, value);
          meta.set(key, options?.metadata);
        },
        delete: async (key: string) => { kv.delete(key); meta.delete(key); },
      },
    } as never,
  };
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function post(path: string, body: unknown) {
  return new Request(`https://feedback.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let github: ReturnType<typeof vi.fn>;

beforeEach(() => {
  github = vi.fn();
  vi.stubGlobal('fetch', github);
  vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitFollowed(env: never) {
  github.mockResolvedValueOnce(json({ html_url: 'https://github.com/owner/repo/issues/7', number: 7 }));
  const res = await worker.fetch(post('/feedback', { title: 't', body: 'long enough body', follow: true }), env, ctx);
  return (await res.json()) as { number: number; secret?: string; canReply?: boolean };
}

describe('follow', () => {
  it('returns a secret and stores only its hash', async () => {
    const { env, kv } = makeEnv();
    const result = await submitFollowed(env);
    expect(result.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(kv.get('follow:7')).toMatch(/^[0-9a-f]{64}$/);
    expect(kv.get('follow:7')).not.toContain(result.secret!);
    expect(result.canReply).toBe(true);
  });

  it('turns replies off when the contact is a verified GitHub handle', async () => {
    const { env } = makeEnv();
    github
      .mockResolvedValueOnce(json({ login: 'someone' }))
      .mockResolvedValueOnce(json({ html_url: 'u', number: 9 }));
    const res = await worker.fetch(
      post('/feedback', { title: 't', body: 'long enough body', contact: '@someone', follow: true }),
      env,
      ctx,
    );
    const result = (await res.json()) as { secret: string; canReply: boolean };
    expect(result.canReply).toBe(false);

    const calls = github.mock.calls.length;
    const reply = await worker.fetch(post('/feedback/reply', { number: 9, secret: result.secret, body: 'still happening here' }), env, ctx);
    expect(reply.status).toBe(403);
    expect(await reply.json()).toEqual({ error: 'reply_on_github' });
    expect(github.mock.calls.length).toBe(calls);

    const forget = await worker.fetch(post('/feedback/forget', { number: 9, secret: result.secret }), env, ctx);
    expect(forget.status).toBe(200);
  });

  it('gives no secret unless asked', async () => {
    const { env, kv } = makeEnv();
    github.mockResolvedValueOnce(json({ html_url: 'u', number: 8 }));
    const res = await worker.fetch(post('/feedback', { title: 't', body: 'long enough body' }), env, ctx);
    expect(((await res.json()) as { secret?: string }).secret).toBeUndefined();
    expect(kv.size).toBe(0);
  });
});

describe('status', () => {
  it('reports the newest non-bot comment and skips unfollowed issues', async () => {
    const { env } = makeEnv();
    await submitFollowed(env);
    github
      .mockResolvedValueOnce(json({ number: 7, state: 'open', locked: false, closed_at: null, updated_at: '2026-10-02T00:00:00Z', comments: 2, user: { login: BOT } }))
      .mockResolvedValueOnce(json([
        { created_at: '2026-10-01T00:00:00Z', user: { login: 'maintainer' } },
        { created_at: '2026-10-02T00:00:00Z', user: { login: BOT } },
      ]));
    const res = await worker.fetch(new Request('https://feedback.test/feedback/status?issues=7,9'), env, ctx);
    expect(await res.json()).toEqual({
      issues: [{ number: 7, state: 'open', locked: false, activityAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' }],
      unknown: [9],
    });
  });

  it('counts closing as activity', async () => {
    const { env } = makeEnv();
    await submitFollowed(env);
    github.mockResolvedValueOnce(json({ number: 7, state: 'closed', locked: false, closed_at: '2026-10-03T00:00:00Z', comments: 0, user: { login: BOT } }));
    const res = await worker.fetch(new Request('https://feedback.test/feedback/status?issues=7'), env, ctx);
    const body = (await res.json()) as { issues: { activityAt: string }[] };
    expect(body.issues[0].activityAt).toBe('2026-10-03T00:00:00Z');
  });

  it('rejects a request without issue numbers', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request('https://feedback.test/feedback/status?issues=abc'), env, ctx);
    expect(res.status).toBe(400);
  });
});

describe('reply', () => {
  it('posts a comment with the right secret', async () => {
    const { env } = makeEnv();
    const { secret } = await submitFollowed(env);
    github
      .mockResolvedValueOnce(json({ number: 7, state: 'open', locked: false, closed_at: null, comments: 0, user: { login: BOT } }))
      .mockResolvedValueOnce(json({ html_url: 'https://github.com/owner/repo/issues/7#issuecomment-1' }));
    const res = await worker.fetch(post('/feedback/reply', { number: 7, secret, body: 'still happening here' }), env, ctx);
    expect(res.status).toBe(200);
    const [url, init] = github.mock.calls.at(-1)!;
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues/7/comments');
    expect(JSON.parse(init.body).body).toContain('still happening here');
  });

  it('refuses a wrong secret without touching GitHub', async () => {
    const { env } = makeEnv();
    await submitFollowed(env);
    const calls = github.mock.calls.length;
    const res = await worker.fetch(post('/feedback/reply', { number: 7, secret: 'nope', body: 'still happening here' }), env, ctx);
    expect(res.status).toBe(403);
    expect(github.mock.calls.length).toBe(calls);
  });

  it('refuses a locked issue', async () => {
    const { env } = makeEnv();
    const { secret } = await submitFollowed(env);
    github.mockResolvedValueOnce(json({ number: 7, state: 'closed', locked: true, closed_at: null, comments: 0, user: { login: BOT } }));
    const res = await worker.fetch(post('/feedback/reply', { number: 7, secret, body: 'still happening here' }), env, ctx);
    expect(res.status).toBe(409);
  });
});

describe('forget', () => {
  it('deletes the follow so the secret stops working', async () => {
    const { env, kv } = makeEnv();
    const { secret } = await submitFollowed(env);
    const res = await worker.fetch(post('/feedback/forget', { number: 7, secret }), env, ctx);
    expect(res.status).toBe(200);
    expect(kv.has('follow:7')).toBe(false);
    const again = await worker.fetch(post('/feedback/reply', { number: 7, secret, body: 'still happening here' }), env, ctx);
    expect(again.status).toBe(403);
  });
});
