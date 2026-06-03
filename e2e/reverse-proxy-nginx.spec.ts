import { test, expect, APIResponse } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Modality TODO #1 — path B: nginx fixture for full TLS-termination test.
 *
 * Path A (reverse-proxy.spec.ts) injects X-Forwarded-Proto directly into the
 * request, which catches the live bug class (the app honoring the header).
 * Path B adds marginal integration coverage by running a real nginx process in
 * front of Next.js: it catches misconfigurations of the reference nginx.conf
 * we ship and actual TLS handshake behavior that path A cannot exercise.
 *
 * Setup required before running:
 *   bash e2e/fixtures/generate-self-signed.sh
 *   nginx -c <abs-path>/e2e/fixtures/nginx.conf
 *
 * TEST-ENVIRONMENT DEPENDENCY:
 * - Requires a seeded DB (E2E_HAS_TEST_DB=1) AND nginx running on port 443
 *   configured per e2e/fixtures/nginx.conf (E2E_NGINX_PROXY=1).
 * - Without both flags every test here is skipped — by design.
 */

const HAS_TEST_DB = process.env.E2E_HAS_TEST_DB === '1';
const HAS_NGINX = process.env.E2E_NGINX_PROXY === '1';
const PIN = process.env.E2E_PIN || '1234';
const NGINX_BASE = 'https://localhost:443';

/**
 * Query the seeded parent's id directly from the DB.
 * Mirrors the same helper in reverse-proxy.spec.ts — see that file for the
 * full explanation of the dev-vs-CI dual-path logic.
 */
function getSeededParentId(): string {
  const cmd = process.env.DATABASE_URL
    ? `psql "${process.env.DATABASE_URL}" -At -c "SELECT id FROM users WHERE role = 'parent' ORDER BY created_at LIMIT 1"`
    : `docker exec prism-db psql -U prism -d prism -At -c "SELECT id FROM users WHERE role = 'parent' ORDER BY created_at LIMIT 1"`;
  const out = execSync(cmd, { encoding: 'utf-8' }).trim();
  if (!out) throw new Error('No seeded parent in DB — did seeds run?');
  return out;
}

function setCookies(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);
}

function findCookie(cookies: string[], name: string): string | undefined {
  return cookies.find((c) => c.startsWith(`${name}=`));
}

test.describe('Reverse-proxy cookie security — nginx TLS fixture (path B)', () => {
  // Accept the self-signed cert for the API request context in this describe block.
  test.use({ ignoreHTTPSErrors: true });

  let parentId: string;

  test.beforeAll(() => {
    if (HAS_TEST_DB && HAS_NGINX) {
      parentId = getSeededParentId();
    }
  });

  test('login via nginx TLS: Set-Cookie has Secure; HttpOnly', async ({ request }) => {
    test.skip(
      !HAS_TEST_DB || !HAS_NGINX,
      'Set E2E_HAS_TEST_DB=1 and E2E_NGINX_PROXY=1 with nginx running on port 443',
    );
    const response = await request.post(`${NGINX_BASE}/api/auth/login`, {
      data: { userId: parentId, pin: PIN },
    });
    expect(response.ok()).toBe(true);

    const session = findCookie(setCookies(response), 'prism_session');
    expect(session, 'prism_session cookie should be set').toBeDefined();
    expect(session, 'Secure flag expected — nginx injected X-Forwarded-Proto: https').toMatch(
      /;\s*Secure(;|$)/i,
    );
    expect(session, 'HttpOnly flag expected').toMatch(/;\s*HttpOnly(;|$)/i);
  });

  test('logout via nginx TLS: cleared Set-Cookie still carries Secure; HttpOnly', async ({ request }) => {
    test.skip(
      !HAS_TEST_DB || !HAS_NGINX,
      'Set E2E_HAS_TEST_DB=1 and E2E_NGINX_PROXY=1 with nginx running on port 443',
    );

    // Establish a session so logout has something to clear.
    const loginResponse = await request.post(`${NGINX_BASE}/api/auth/login`, {
      data: { userId: parentId, pin: PIN },
    });
    expect(loginResponse.ok(), 'precondition: login via nginx must succeed').toBe(true);

    const response = await request.post(`${NGINX_BASE}/api/auth/logout`);
    expect(response.ok()).toBe(true);

    const session = findCookie(setCookies(response), 'prism_session');
    expect(session, 'logout should re-emit prism_session as a cleared Set-Cookie').toBeDefined();
    expect(session, 'cleared cookie must still carry Secure').toMatch(/;\s*Secure(;|$)/i);
    expect(session, 'cleared cookie must still carry HttpOnly').toMatch(/;\s*HttpOnly(;|$)/i);
  });
});
