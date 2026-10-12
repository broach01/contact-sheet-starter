// Isolated simulated provider test. Never uses a real account or network.
import assert from "node:assert/strict";
import { db } from "./fixtures/blob.mjs";
import { hash } from "../server/security.mjs";
import sharp from "sharp";
process.env.OWNER_EMAIL = "owner@example.test";
process.env.APP_ORIGIN = "https://gallery.example.test";
process.env.SESSION_SECRET = "isolated-test-session-secret-not-for-deployment";
process.env.GOOGLE_CLIENT_ID = "isolated-test-client";
process.env.GOOGLE_CLIENT_SECRET = "isolated-test-secret";
process.env.BLOB_READ_WRITE_TOKEN = "isolated-test-storage";
let identity = "owner@example.test";
globalThis.fetch = async (url) => {
  if (String(url).includes("oauth2.googleapis.com/token"))
    return Response.json({
      access_token: "fixture",
      refresh_token: "fixture-refresh",
      scope: "openid email https://www.googleapis.com/auth/drive.file",
      expires_in: 3600,
    });
  if (String(url).includes("openidconnect.googleapis.com/v1/userinfo"))
    return Response.json({ email: identity, email_verified: true });
  if (String(url).includes("oauth2.googleapis.com/revoke"))
    return new Response("");
  throw Error("Unexpected external request: " + url);
};
const { default: api } = await import("../api/handler.mjs");
const origin = process.env.APP_ORIGIN;
const req = (path, { method = "GET", cookie = "", body } = {}) =>
  api.fetch(
    new Request(origin + path, {
      method,
      headers: { origin, cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const cookie = (r) =>
  r.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .join("; ");
let r = await req("/api/app/setup-status");
let status = await r.json();
assert.equal(status.ownerEmail, identity);
assert.equal(status.password, false);
assert.equal(status.google, true);
r = await api.fetch(
  new Request("https://wrong.example.test/api/admin/recovery"),
);
assert.equal(r.status, 400);
async function verify() {
  let r = await req("/api/admin/recovery");
  assert.equal(r.status, 302);
  const auth = new URL(r.headers.get("location"));
  assert.equal(auth.searchParams.get("login_hint"), "owner@example.test");
  assert.equal(
    auth.searchParams.get("redirect_uri"),
    origin + "/api/admin/drive/callback",
  );
  assert(auth.searchParams.get("code_challenge"));
  const state = auth.searchParams.get("state");
  return req("/api/admin/drive/callback?state=" + state + "&code=fixture", {
    cookie: cookie(r),
  });
}
identity = "wrong@example.test";
r = await verify();
assert.equal(r.status, 403);
identity = "owner@example.test";
r = await verify();
assert.equal(r.status, 303);
const recovery = cookie(r);
r = await req("/api/admin/recovery/reset", {
  method: "POST",
  cookie: recovery,
  body: { newPassword: "fixture-long-password" },
});
assert.equal(r.status, 200);
const admin = cookie(r);
r = await req("/api/admin/recovery/reset", {
  method: "POST",
  cookie: recovery,
  body: { newPassword: "fixture-other-password" },
});
assert.equal(r.status, 401);
r = await req("/api/app/setup-status");
assert.equal((await r.json()).password, true);
r = await req("/api/admin/login", {
  method: "POST",
  body: { password: "fixture-long-password" },
});
assert.equal(r.status, 200);
r = await req("/api/admin/galleries", {
  method: "POST",
  cookie: admin,
  body: {
    title: "Isolated first gallery",
    photographer: "Owner",
    high_res: false,
  },
});
assert.equal(r.status, 201);
const g = await r.json();
const pid = crypto.randomUUID(),
  proof = `media/${g.id}/${pid}/proof`;
const bytes = await sharp({
  create: { width: 1200, height: 800, channels: 3, background: "#436691" },
})
  .jpeg()
  .toBuffer();
db.set(proof, bytes);
r = await req(`/api/admin/galleries/${g.id}/photos`, {
  method: "POST",
  cookie: admin,
  body: {
    photoId: pid,
    title: "Test photo",
    filename: "test.jpg",
    hasOriginal: false,
  },
});
assert.equal(r.status, 200);
r = await req(`/api/admin/galleries/${g.id}/settings`, {
  method: "PATCH",
  cookie: admin,
  body: {
    web_downloads: true,
    watermark: true,
    watermark_type: "text",
    watermark_placement: "diagonal",
  },
});
assert.equal(r.status, 200);
const record = db.get("jobs/" + (await hash(g.token)) + ".json");
record.preview = `media/${g.id}/share.png`;
db.set(record.preview, bytes);
r = await req(`/api/admin/galleries/${g.id}/publish`, {
  method: "POST",
  cookie: admin,
  body: {},
});
assert.equal(r.status, 200);
r = await req("/api/galleries/" + g.token);
const publicGallery = await r.json();
assert.equal(publicGallery.photos.length, 1);
assert.equal(publicGallery.downloads, false);
r = await req(`/api/galleries/${g.token}/media/${pid}/web`);
assert.equal(r.status, 200);
assert.notDeepEqual(Buffer.from(await r.arrayBuffer()), bytes);
r = await req("/api/galleries/" + g.token + "/picks", {
  method: "PUT",
  body: { photoId: pid, selection: "liked" },
});
assert.equal(r.status, 200);
r = await req(`/api/galleries/${g.token}/comments/${pid}`, {
  method: "POST",
  body: { id: crypto.randomUUID(), text: "Fixture note" },
});
assert.equal(r.status, 201);
r = await req("/api/galleries/" + g.token + "/open", {
  method: "POST",
  body: {},
});
assert.equal(r.status, 200);
r = await req("/api/admin/drive/connect", { cookie: admin });
assert.equal(r.status, 302);
assert.equal(
  new URL(r.headers.get("location")).searchParams.get("login_hint"),
  "owner@example.test",
);
console.log(
  "PASS isolated first-owner bootstrap, wrong identity/host rejected, password replay rejected, login, gallery creation/upload/publish, marked web bytes, hearts/notes/counter, owner Drive approval URL. Real Google/Vercel account setup is not simulated proof of a live install.",
);
