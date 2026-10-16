import assert from "node:assert/strict";
import { after, test } from "node:test";

// Isolate tests from all local/production credentials and MongoDB data.
process.env.MONGO_URI = "";
process.env.ADMIN_USERNAME = "test-admin";
process.env.ADMIN_PASSWORD = "test-password";
process.env.JWT_SECRET = "test-only-secret-not-for-production";
const origin = "https://billing-app-frontent-git-main-rufus005s-projects.vercel.app";
process.env.CLIENT_URL = `${origin}/, https://billing-app-frontent.vercel.app`;
const { default: app } = await import("../app.js");
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
after(() => new Promise((resolve) => server.close(resolve)));
const base = `http://127.0.0.1:${server.address().port}`;

test("frontend preflight succeeds before authentication", async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-max-age"), "600");
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.match(response.headers.get("access-control-allow-methods"), /POST/);
  assert.match(response.headers.get("access-control-allow-headers"), /authorization/);
});

test("untrusted origins are rejected", async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "OPTIONS", headers: { Origin: "https://untrusted.example",
      "Access-Control-Request-Method": "POST" },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("login issues a usable token and keeps billing routes protected", async () => {
  const login = (body) => fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const invalid = await login({ username: "test-admin", password: "wrong" });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get("access-control-allow-origin"), origin);
  const valid = await login({ username: "test-admin", password: "test-password" });
  assert.equal(valid.status, 200);
  const { token } = await valid.json();
  const me = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
  });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { username: "test-admin" });
  assert.equal((await fetch(`${base}/api/products`)).status, 401);
  assert.equal((await fetch(`${base}/api/products`, {
    headers: { Authorization: `Bearer ${token}` },
  })).status, 503);
});
