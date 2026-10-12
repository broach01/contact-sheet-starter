import { test } from "node:test";
import assert from "node:assert/strict";
import {
  token,
  hash,
  sign,
  validSession,
  sameOrigin,
  escapeHTML,
  passwordHash,
} from "../server/security.mjs";
test("tokens are unpredictable and hashed", async () => {
  const a = token(),
    b = token();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
  assert.notEqual(a, await hash(a));
});
test("sessions reject tampering, expiry and wrong key", async () => {
  const secret = "test-only-secret",
    exp = String(Date.now() + 60000),
    cookie = exp + "." + (await sign(exp, secret));
  assert.equal(await validSession(cookie, secret), true);
  assert.equal(await validSession(cookie, "wrong"), false);
  assert.equal(await validSession(cookie + "a", secret), false);
  assert.equal(await validSession(cookie, secret, Number(exp) + 1), false);
});
test("writes need exact same origin", () => {
  assert.equal(
    sameOrigin(
      new Request("https://example.test/api", {
        headers: { Origin: "https://example.test" },
      }),
    ),
    true,
  );
  assert.equal(
    sameOrigin(
      new Request("https://example.test/api", {
        headers: { Origin: "https://evil.test" },
      }),
    ),
    false,
  );
});
test("share title escapes HTML injection", () => {
  assert.equal(escapeHTML('<script>"&'), "&lt;script&gt;&quot;&amp;");
});
test("password hashes depend on salt", async () => {
  assert.notEqual(
    await passwordHash("test password", "a"),
    await passwordHash("test password", "b"),
  );
});
