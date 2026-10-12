const ownerEmail = () =>
  String(process.env.OWNER_EMAIL || "")
    .trim()
    .toLowerCase();
const appOrigin = () => String(process.env.APP_ORIGIN || "").replace(/\/$/, "");
import { put, get, list, head, del } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import {
  hash,
  token,
  sign,
  equal,
  validSession,
  passwordHash,
  sameOrigin,
  escapeHTML,
} from "../server/security.mjs";
import { readFile, readdir } from "node:fs/promises";
import { watermarkProof } from "../server/watermark.mjs";
import { createHash } from "node:crypto";
const opts = { access: "private" },
  json = (b, s = 200) =>
    Response.json(b, { status: s, headers: { "Cache-Control": "no-store" } }),
  fail = (e, s = 400) => json({ error: e }, s);
async function read(key) {
  const b = await get(key, { ...opts, useCache: false });
  return b ? await new Response(b.stream).json() : null;
}
function websiteLink(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 2048) throw Error("Website link is too long.");
  const input = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : "https://" + text;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw Error("Enter a valid website link.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw Error("Use an http or https website link.");
  return input;
}
async function write(key, data) {
  return put(key, JSON.stringify(data), {
    ...opts,
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}
async function feedAuth(req) {
  const secret = process.env.NOTIFICATION_FEED_TOKEN;
  if (!secret) return false;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (bearer && equal(bearer, secret)) return true;
  const c = (req.headers.get("cookie") || "").match(
    /(?:^|;\s*)broach_feed=([^;]+)/,
  )?.[1];
  return validSession(c, secret);
}
async function credentials() {
  return (
    (await read("private/admin-auth.json")) || {
      salt: process.env.ADMIN_PASSWORD_SALT,
      hash: process.env.ADMIN_PASSWORD_HASH,
      version: "",
    }
  );
}
async function sessionSecret(auth = undefined) {
  auth = auth || (await credentials());
  return auth.version
    ? await sign(auth.version, process.env.SESSION_SECRET)
    : process.env.SESSION_SECRET;
}
async function admin(req) {
  return validSession(
    (req.headers.get("cookie") || "").match(
      /(?:^|;\s*)broach_admin=([^;]+)/,
    )?.[1],
    await sessionSecret(),
  );
}
async function adminCookie(ttl = 86400) {
  const exp = String(Date.now() + ttl * 1000);
  return `broach_admin=${exp}.${await sign(exp, await sessionSecret())}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ttl}`;
}
async function recoveryValid(req) {
  const cookie = (req.headers.get("cookie") || "").match(
    /(?:^|;\s*)broach_recovery=([^;]+)/,
  )?.[1];
  if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return false;
  const r = await read("private/recovery/" + (await hash(cookie)) + ".json");
  return (
    r && r.expires > Date.now() && r.version === (await credentials()).version
  );
}
async function recovery(req, u) {
  if (!(appOrigin() && u.origin === appOrigin()))
    return fail("Use the production gallery address.", 400);
  if (
    !ownerEmail() ||
    !process.env.SESSION_SECRET ||
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET
  )
    return fail("Google recovery unavailable.", 503);
  const state = token(),
    verifier = token() + token();
  await write("private/oauth/" + (await hash(state)) + ".json", {
    expires: Date.now() + 600000,
    mode: "recovery",
    encrypted: await seal({ verifier }),
  });
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: u.origin + "/api/admin/drive/callback",
    response_type: "code",
    scope: "openid email",
    prompt: "select_account",
    login_hint: ownerEmail(),
    state,
    code_challenge: Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url"),
    code_challenge_method: "S256",
  });
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      Location: target.href,
      "Set-Cookie": `broach_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/admin/drive; Max-Age=600`,
    },
  });
}
async function changePassword(req, reset) {
  const now = Date.now(),
    ip = await hash(req.headers.get("x-forwarded-for") || "local"),
    key = "attempts/password-" + ip + ".json",
    attempt = await read(key);
  if (attempt?.reset > now && attempt.count >= 5)
    return fail("Wait 15 minutes before retrying.", 429);
  if (reset ? !(await recoveryValid(req)) : !(await admin(req)))
    return fail("Sign in or recover with Google first.", 401);
  const b = await req.json(),
    auth = await credentials();
  if (
    typeof b.newPassword !== "string" ||
    b.newPassword.length < 12 ||
    b.newPassword.length > 256
  )
    return fail("Choose a password between 12 and 256 characters.");
  if (
    !reset &&
    (typeof b.currentPassword !== "string" ||
      b.currentPassword.length > 256 ||
      !equal(await passwordHash(b.currentPassword, auth.salt), auth.hash))
  ) {
    await write(key, {
      count: attempt?.reset > now ? attempt.count + 1 : 1,
      reset: now + 900000,
    });
    return fail("Current password is incorrect.", 401);
  }
  const salt = token();
  await write("private/admin-auth.json", {
    salt,
    hash: await passwordHash(b.newPassword, salt),
    version: token(),
    changed_at: now,
  });
  await del(key);
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", await adminCookie());
  headers.append(
    "Set-Cookie",
    "broach_recovery=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0",
  );
  return new Response(JSON.stringify({ ok: true }), { headers });
}

function slug(g) {
  const title =
    g.title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32)
      .replace(/-$/, "") || "job";
  return (
    title + "-" + Buffer.from(g.token.slice(0, 32), "hex").toString("base64url")
  );
}
function clientPath(g) {
  return (
    "/p/" +
    slug(g) +
    "?utm_source=client-gallery&utm_medium=gallery-link&utm_campaign=" +
    encodeURIComponent(slug(g).slice(0, -23))
  );
}
async function publicJob(id) {
  if (/^[a-f0-9]{64}$/.test(id)) return job(id);
  const short = /^[A-Za-z0-9_-]{22}$/.test(id);
  if (!short && !/^[a-z0-9-]+-[A-Za-z0-9_-]{22}$/.test(id)) return null;
  const all = await allBlobs("jobs/");
  for (let i = 0; i < all.length; i += 8) {
    const batch = await Promise.all(
      all.slice(i, i + 8).map((item) => read(item.pathname)),
    );
    const found = batch.find(
      (g) =>
        g &&
        (short
          ? Buffer.from(g.token.slice(0, 32), "hex").toString("base64url") ===
            id
          : slug(g) === id),
    );
    if (found) return found;
  }
  return null;
}
async function allBlobs(prefix) {
  let cursor,
    rows = [];
  do {
    const page = await list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return rows;
}
async function comments(g, pid) {
  const rows = await allBlobs(`comments/${g.id}/${pid}/`);
  return (await Promise.all(rows.map((x) => read(x.pathname))))
    .filter(Boolean)
    .sort((a, b) => a.created_at - b.created_at);
}
async function galleryComments(g) {
  const rows = await allBlobs(`comments/${g.id}/`),
    groups = {};
  for (const item of rows) {
    const pid = item.pathname.split("/")[2],
      note = await read(item.pathname);
    if (note) (groups[pid] ??= []).push(note);
  }
  for (const notes of Object.values(groups))
    notes.sort((a, b) => a.created_at - b.created_at);
  return groups;
}
async function publicPhotoState(g) {
  const [pickRows, noteRows] = await Promise.all([
    allBlobs(`picks/${g.id}/`),
    allBlobs(`comments/${g.id}/`),
  ]);
  const picks = {},
    counts = {};
  for (let i = 0; i < pickRows.length; i += 12) {
    const rows = await Promise.all(
      pickRows
        .slice(i, i + 12)
        .map(async (item) => ({
          pid: item.pathname.split("/")[2]?.replace(/\.json$/, ""),
          value: await read(item.pathname),
        })),
    );
    for (const row of rows) if (row.value) picks[row.pid] = row.value;
  }
  for (const item of noteRows) {
    const pid = item.pathname.split("/")[2];
    counts[pid] = (counts[pid] || 0) + 1;
  }
  return g.photos.map((p) => ({
    id: p.id,
    title: p.title,
    filename: p.filename,
    has_original: !!(p.driveOriginal || p.original),
    hearted: !!picks[p.id]?.hearted,
    rejected: !!picks[p.id]?.rejected,
    comment_count: counts[p.id] || 0,
  }));
}

async function markedProof(g, photo) {
  const branding =
    g.watermark_type === "logo" ? await read("private/branding.json") : null;
  const text = (
    g.watermark_text ||
    (g.photographer ?? "") ||
    g.title ||
    "Photography"
  )
    .trim()
    .slice(0, 100);
  const signature = await hash(
    JSON.stringify({
      proof: photo.proof,
      type: g.watermark_type || "text",
      placement: g.watermark_placement || "corner",
      text,
      logo: branding?.version || "default",
      v: 2,
    }),
  );
  const path = `watermarks/${g.id}/${signature}/${photo.id}.jpg`;
  const cached = await get(path, { ...opts, useCache: false });
  if (cached) return cached;
  const source = await get(photo.proof, { ...opts, useCache: false });
  if (!source) throw Error("Proof unavailable.");
  let logo;
  if (g.watermark_type === "logo") {
    if (branding?.path) {
      const object = await get(branding.path, { ...opts, useCache: false });
      if (!object) throw Error("Watermark logo unavailable.");
      logo = Buffer.from(await new Response(object.stream).arrayBuffer());
    } else {
      const assets = new URL("../dist/assets/", import.meta.url);
      const filename = (await readdir(assets)).find((x) =>
        /^contact-sheet-.*\.png$/.test(x),
      );
      if (!filename) throw Error("Default logo unavailable.");
      logo = await readFile(new URL(filename, assets));
    }
  }
  const result = await watermarkProof(
    Buffer.from(await new Response(source.stream).arrayBuffer()),
    {
      type: g.watermark_type || "text",
      placement: g.watermark_placement || "corner",
      text,
      logo,
    },
  );
  await put(path, result, {
    ...opts,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "image/jpeg",
  });
  return {
    stream: new Response(result).body,
    statusCode: 200,
    blob: {
      contentType: "image/jpeg",
      size: result.length,
      etag: '"' + signature + '"',
    },
  };
}
async function galleryViews(g) {
  const rows = await allBlobs(`views/${g.id}/`);
  const times = rows
    .map((x) => Number(x.pathname.split("/")[2]?.split("-")[0]))
    .filter(Number.isFinite);
  return {
    view_count: times.length,
    first_viewed_at: times.length ? Math.min(...times) : null,
    last_viewed_at: times.length ? Math.max(...times) : null,
  };
}
async function activity(g, kind, photoId, id = crypto.randomUUID()) {
  await write(`activity/${g.id}/${id}.json`, {
    id,
    kind,
    photoId,
    created_at: Date.now(),
  });
}
async function notices() {
  const jobs = await allBlobs("jobs/"),
    rows = [];
  for (const item of jobs) {
    const g = await read(item.pathname);
    if (!g?.published) continue;
    const state = (await read(`notified/${g.id}.json`)) || {
      cutoff: 0,
      last_notified_at: 0,
    };
    const events = (
      await Promise.all(
        (await allBlobs(`activity/${g.id}/`)).map((x) => read(x.pathname)),
      )
    )
      .filter((x) => x && x.created_at > state.cutoff)
      .sort((a, b) => a.created_at - b.created_at);
    if (!events.length) continue;
    const due_at = state.last_notified_at
      ? state.last_notified_at + 10800000
      : events[0].created_at;
    rows.push({
      job_id: g.id,
      title: g.title,
      path: clientPath(g),
      due: Date.now() >= due_at,
      due_at,
      cutoff: events[events.length - 1].created_at,
      new_hearts: events.filter((x) => x.kind === "heart").length,
      new_comments: await Promise.all(
        events
          .filter((x) => x.kind === "comment")
          .map(async (x) => ({
            id: x.id,
            photo_id: x.photoId,
            image:
              g.photos.find((p) => p.id === x.photoId)?.title ||
              g.photos.find((p) => p.id === x.photoId)?.filename ||
              "Image",
            text:
              (await read(`comments/${g.id}/${x.photoId}/${x.id}.json`))
                ?.text || "",
          })),
      ),
      current_hearts: (await getPicks(g)).filter((x) => x.hearted).length,
    });
  }
  return rows;
}
async function job(t) {
  return read("jobs/" + (await hash(t)) + ".json");
}
async function handler(req) {
  try {
    return await route(req);
  } catch (e) {
    console.error("Gallery request failed", e.message);
    if (
      new URL(req.url).pathname.startsWith("/api/admin/drive/test") ||
      /\/migration-(copy|remove)$/.test(new URL(req.url).pathname)
    )
      return fail(String(e.message || "Drive test failed.").slice(0, 400), 500);
    return fail("Request failed. Please retry.", 500);
  }
}

async function seal(value) {
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(process.env.SESSION_SECRET),
    ),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
  return (
    Buffer.from(iv).toString("base64url") +
    "." +
    Buffer.from(data).toString("base64url")
  );
}
async function unseal(value) {
  const [iv, data] = value.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(process.env.SESSION_SECRET),
    ),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
        key,
        Buffer.from(data, "base64url"),
      ),
    ),
  );
}
async function driveOAuth(req, u) {
  const p = u.pathname,
    origin = u.origin,
    callback = origin + "/api/admin/drive/callback",
    headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (!(appOrigin() && origin === appOrigin()))
    return fail("Use the production gallery address.", 400);
  if (
    !ownerEmail() ||
    !process.env.SESSION_SECRET ||
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET
  )
    return fail("Google connection is not configured yet.", 503);
  if (p === "/api/admin/drive/status") {
    if (!(await admin(req))) return fail("Sign in.", 401);
    const saved = await read("private/google-drive.json");
    return json({ connected: !!saved, account: saved?.account || null });
  }
  if (p === "/api/admin/drive/connect") {
    if (!(await admin(req)))
      return new Response(
        "Sign in at the gallery admin, then tap Connect Google Drive.",
        { status: 401, headers: { ...headers, "Content-Type": "text/plain" } },
      );
    const state = token(),
      verifier = token() + token(),
      expires = Date.now() + 600000;
    await write("private/oauth/" + (await hash(state)) + ".json", {
      expires,
      encrypted: await seal({ verifier }),
    });
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: callback,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
      login_hint: ownerEmail(),
      state,
      code_challenge: Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ).toString("base64url"),
      code_challenge_method: "S256",
    });
    return new Response(null, {
      status: 302,
      headers: {
        ...headers,
        Location: target.href,
        "Set-Cookie": `broach_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/admin/drive; Max-Age=600`,
      },
    });
  }
  if (p === "/api/admin/drive/callback") {
    const state = u.searchParams.get("state") || "",
      cookie = (req.headers.get("cookie") || "").match(
        /(?:^|;\s*)broach_oauth=([^;]+)/,
      )?.[1];
    if (!/^[a-f0-9]{64}$/.test(state) || !cookie || !equal(state, cookie))
      return fail(
        "Google approval expired or came from a different browser. Please start again.",
        400,
      );
    const path = "private/oauth/" + (await hash(state)) + ".json",
      pending = await read(path);
    if (!pending || pending.expires < Date.now())
      return fail("Google approval expired. Please start again.", 400);
    await del(path);
    if (u.searchParams.has("error"))
      return new Response("Google connection cancelled. No files changed.", {
        headers: { ...headers, "Content-Type": "text/plain" },
      });
    const { verifier } = await unseal(pending.encrypted);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: u.searchParams.get("code") || "",
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callback,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    if (!response.ok)
      return fail(
        "Google approval could not be completed. Please start again.",
        400,
      );
    const tokens = await response.json();
    if (pending.mode === "recovery") {
      const who = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        { headers: { Authorization: "Bearer " + tokens.access_token } },
      );
      if (!who.ok) return fail("Could not verify the Google account.", 400);
      const identity = await who.json();
      if (identity.email !== ownerEmail() || identity.email_verified !== true)
        return fail("Recovery requires the configured owner account.", 403);
      const receipt = token();
      await write("private/recovery/" + (await hash(receipt)) + ".json", {
        expires: Date.now() + 600000,
        version: (await credentials()).version,
      });
      const h = new Headers({ ...headers, Location: "/admin?recover=1" });
      h.append(
        "Set-Cookie",
        `broach_recovery=${receipt}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=600`,
      );
      h.append(
        "Set-Cookie",
        "broach_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/admin/drive; Max-Age=0",
      );
      return new Response(null, { status: 303, headers: h });
    }
    if (
      !String(tokens.scope || "")
        .split(" ")
        .includes("https://www.googleapis.com/auth/drive.file")
    )
      return new Response(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive connection incomplete</title><main style="font:24px Arial;max-width:650px;margin:40px auto;padding:20px"><h1>Google Drive connection incomplete</h1><p>Files access was not granted. Tap Connect Google Drive again and allow access to files used with this app.</p><p>No photos have been moved or deleted. Your existing connection has not been replaced.</p><a href="/admin">Back to gallery admin</a></main>',
        {
          status: 400,
          headers: {
            ...headers,
            "Content-Type": "text/html",
            "Set-Cookie":
              "broach_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/admin/drive; Max-Age=0",
          },
        },
      );
    const who = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: "Bearer " + tokens.access_token } },
    );
    if (!who.ok) return fail("Could not verify the Google account.", 400);
    const identity = await who.json();
    if (identity.email !== ownerEmail() || identity.email_verified !== true) {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.refresh_token || tokens.access_token,
        }),
      });
      return fail(
        "Only the configured owner account is allowed. No files were changed.",
        403,
      );
    }
    if (!tokens.refresh_token)
      return fail(
        "Google did not return lasting access. Please reconnect.",
        400,
      );
    driveCache = null;
    await write("private/google-drive.json", {
      account: identity.email,
      connected_at: Date.now(),
      encrypted: await seal({ refresh_token: tokens.refresh_token }),
    });
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive connected</title><main style="font:24px Arial;max-width:650px;margin:40px auto;padding:20px"><h1>Google Drive connected</h1><p>Connected only to the configured owner account.</p><p>No photos have been moved or deleted yet. Original storage setup and verification are next.</p><a href="/admin">Back to gallery admin</a></main>',
      {
        headers: {
          ...headers,
          "Content-Type": "text/html",
          "Set-Cookie":
            "broach_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/admin/drive; Max-Age=0",
        },
      },
    );
  }
  return fail("Not found.", 404);
}

let driveCache = null;
async function driveToken() {
  if (driveCache && driveCache.expires > Date.now() + 60000)
    return driveCache.token;
  const saved = await read("private/google-drive.json");
  if (saved?.account !== ownerEmail())
    throw Error("Connect the personal owner Google Drive first.");
  const secret = await unseal(saved.encrypted),
    r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: secret.refresh_token,
        grant_type: "refresh_token",
      }),
    });
  if (!r.ok)
    throw Error(
      "Google Drive connection expired. Reconnect the personal account.",
    );
  const b = await r.json();
  if (
    b.scope &&
    !b.scope.split(" ").includes("https://www.googleapis.com/auth/drive.file")
  )
    throw Error(
      "Google Drive permission was not granted. Tap Connect Google Drive again and allow access to files used with this app.",
    );
  const auth = { Authorization: "Bearer " + b.access_token };
  const who = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: auth,
  });
  if (!who.ok)
    throw Error(
      "Google identity check failed (" +
        who.status +
        "). Reconnect Google Drive.",
    );
  const identity = await who.json();
  if (identity.email !== ownerEmail() || identity.email_verified !== true)
    throw Error(
      "The connected Google account is not the approved personal owner account. Reconnect the configured owner account.",
    );
  const about = await fetch(
    "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota",
    { headers: auth },
  );
  if (!about.ok) {
    const detail = await about.json().catch(() => ({})),
      reason = String(
        detail.error?.errors?.[0]?.reason || detail.error?.status || "unknown",
      )
        .replace(/[^A-Za-z0-9_]/g, "")
        .slice(0, 80);
    throw Error(
      "Drive permission check failed (" +
        about.status +
        ", " +
        reason +
        "). Reconnect Google Drive and allow access to app files.",
    );
  }
  const account = await about.json();
  if (account.user?.emailAddress !== ownerEmail())
    throw Error("Drive account does not match the approved owner account.");
  driveCache = {
    token: b.access_token,
    expires: Date.now() + Math.min(b.expires_in || 3600, 3600) * 1000,
  };
  return driveCache.token;
}
async function driveFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", "Bearer " + (await driveToken()));
  const r = await fetch(url, { ...options, headers });
  if (!r.ok) {
    if (r.status === 401) driveCache = null;
    throw Error("Google Drive request failed (" + r.status + "). Retry later.");
  }
  return r;
}
const driveFields =
  "id,name,mimeType,size,parents,sha256Checksum,md5Checksum,trashed,driveId,shared,owners(emailAddress),permissions(type,role,emailAddress),appProperties";
async function driveMeta(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error("Invalid Drive file.");
  return (
    await driveFetch(
      "https://www.googleapis.com/drive/v3/files/" +
        id +
        "?fields=" +
        encodeURIComponent(driveFields),
    )
  ).json();
}
function privatePersonal(file) {
  if (
    file.trashed ||
    file.driveId ||
    file.shared ||
    file.owners?.length !== 1 ||
    file.owners[0].emailAddress !== ownerEmail() ||
    !file.permissions?.length ||
    file.permissions?.some(
      (p) =>
        p.role !== "owner" ||
        p.type !== "user" ||
        p.emailAddress !== ownerEmail(),
    )
  )
    throw Error(
      "Original storage must be private in the personal owner Drive.",
    );
  return file;
}
async function privateFolder(key, name, parent) {
  const query = `trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='broachFolder' and value='${key}' }`;
  const rows = await (
    await driveFetch(
      "https://www.googleapis.com/drive/v3/files?q=" +
        encodeURIComponent(query) +
        "&fields=" +
        encodeURIComponent("files(" + driveFields + ")"),
    )
  ).json();
  if (rows.files.length > 1)
    throw Error(
      "Multiple original folders found. Check storage before continuing.",
    );
  let folder = rows.files[0];
  if (!folder)
    folder = await (
      await driveFetch(
        "https://www.googleapis.com/drive/v3/files?fields=" +
          encodeURIComponent(driveFields),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: parent ? [parent] : ["root"],
            appProperties: { broachFolder: key },
          }),
        },
      )
    ).json();
  privatePersonal(folder);
  if (parent && !folder.parents?.includes(parent))
    throw Error("Original folder is outside the private root.");
  return folder;
}
async function driveFolder(g) {
  const root = await privateFolder("root", "Contact Sheet Originals");
  return privateFolder(g.id, g.title + " - " + g.id.slice(0, 8), root.id);
}
async function originalSession(g, b, origin) {
  if (
    !/^[a-f0-9-]{36}$/.test(b.photoId) ||
    !Number.isInteger(b.size) ||
    b.size < 1 ||
    b.size > 80 * 1024 * 1024 ||
    !["image/jpeg", "image/png", "image/webp", "image/tiff"].includes(
      b.mimeType,
    ) ||
    typeof b.filename !== "string" ||
    !b.filename ||
    b.filename.length > 200 ||
    !/^[a-fA-F0-9]{64}$/.test(b.sha256)
  )
    throw Error("Invalid original upload.");
  const path = `private/uploads/${g.id}/${b.photoId}.json`,
    previous = await read(path);
  if (
    previous &&
    (previous.size !== b.size ||
      previous.sha256 !== b.sha256.toLowerCase() ||
      previous.filename !== b.filename)
  )
    throw Error("Original changed during this upload. Choose a new batch.");
  if (previous && previous.expires > Date.now())
    return { session: await unseal(previous.session), fileId: previous.fileId };
  const folder = await driveFolder(g),
    ids = await (
      await driveFetch(
        "https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files",
      )
    ).json(),
    fileId = ids.ids[0];
  const r = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=" +
      encodeURIComponent(driveFields),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Content-Type": b.mimeType,
        "X-Upload-Content-Length": String(b.size),
        Origin: origin,
      },
      body: JSON.stringify({
        id: fileId,
        name: b.filename,
        mimeType: b.mimeType,
        parents: [folder.id],
        appProperties: { broachJob: g.id, broachPhoto: b.photoId },
      }),
    },
  );
  const session = r.headers.get("Location");
  if (!session || new URL(session).origin !== "https://www.googleapis.com")
    throw Error("Drive did not create a secure upload session.");
  await write(path, {
    fileId,
    folderId: folder.id,
    size: b.size,
    sha256: b.sha256.toLowerCase(),
    filename: b.filename,
    mimeType: b.mimeType,
    session: await seal(session),
    expires: Date.now() + 604800000,
  });
  return { session, fileId };
}
async function privateJobFolder(folderId, g) {
  const f = privatePersonal(await driveMeta(folderId));
  if (
    f.mimeType !== "application/vnd.google-apps.folder" ||
    f.appProperties?.broachFolder !== g.id ||
    f.parents?.length !== 1
  )
    throw Error("Invalid job originals folder.");
  const root = privatePersonal(await driveMeta(f.parents[0]));
  if (
    root.appProperties?.broachFolder !== "root" ||
    root.mimeType !== "application/vnd.google-apps.folder"
  )
    throw Error("Invalid originals root.");
  return f;
}
async function verifyOriginal(g, pid) {
  const pending = await read(`private/uploads/${g.id}/${pid}.json`);
  if (!pending) throw Error("Start the original upload first.");
  const file = privatePersonal(await driveMeta(pending.fileId));
  if (
    file.size !== String(pending.size) ||
    file.sha256Checksum !== pending.sha256 ||
    file.name !== pending.filename ||
    file.mimeType !== pending.mimeType ||
    file.parents?.length !== 1 ||
    file.parents[0] !== pending.folderId ||
    file.appProperties?.broachJob !== g.id ||
    file.appProperties?.broachPhoto !== pid
  )
    throw Error("Original upload is incomplete or did not pass verification.");
  await privateJobFolder(pending.folderId, g);
  return {
    id: file.id,
    folder: pending.folderId,
    size: pending.size,
    sha256: pending.sha256,
    mimeType: pending.mimeType,
  };
}
async function originalDownload(req, g, photo) {
  const file = privatePersonal(await driveMeta(photo.driveOriginal.id));
  if (
    file.parents?.length !== 1 ||
    file.parents[0] !== photo.driveOriginal.folder ||
    file.sha256Checksum !== photo.driveOriginal.sha256 ||
    file.size !== String(photo.driveOriginal.size) ||
    file.appProperties?.broachJob !== g.id ||
    file.appProperties?.broachPhoto !== photo.id
  )
    throw Error("Original file no longer matches the saved photograph.");
  await privateJobFolder(photo.driveOriginal.folder, g);
  const headers = {};
  const range = req.headers.get("Range");
  if (range && /^bytes=\d+-\d*$/.test(range)) headers.Range = range;
  const r = await driveFetch(
    "https://www.googleapis.com/drive/v3/files/" +
      photo.driveOriginal.id +
      "?alt=media",
    { headers },
  );
  const out = new Headers({
    "Content-Type": photo.driveOriginal.mimeType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(photo.filename)}`,
    "Cache-Control": "private,no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  for (const key of ["Content-Length", "Content-Range", "Accept-Ranges"])
    if (r.headers.has(key)) out.set(key, r.headers.get(key));
  return new Response(r.body, { status: r.status, headers: out });
}

async function driveTest(req, u) {
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
    !sameOrigin(req)
  )
    return fail("Invalid request origin.", 403);
  if (u.pathname === "/api/admin/drive/test-status" && req.method === "GET") {
    const receipt = u.searchParams.get("receipt") || "";
    if (!/^[a-f0-9]{64}$/.test(receipt)) return fail("Invalid test receipt.");
    const t = await read("private/tests/" + (await hash(receipt)) + ".json");
    if (!t) return fail("Test not found.", 404);
    return json({
      status: t.status,
      created_at: t.created_at,
      finished_at: t.finished_at,
      diagnostics: t.diagnostics,
    });
  }
  if (!(await admin(req))) return fail("Sign in.", 401);
  const now = Date.now();
  if (u.pathname === "/api/admin/drive/test" && req.method === "POST") {
    const root = await privateFolder("root", "Contact Sheet Originals"),
      g = {
        id: crypto.randomUUID(),
        title: "Drive storage test - not a client job",
        photos: [],
      },
      pid = crypto.randomUUID(),
      b = await req.json();
    const session = await originalSession(
        g,
        {
          photoId: pid,
          filename: "drive-storage-test.bin.jpg",
          mimeType: "image/jpeg",
          size: b.size,
          sha256: b.sha256,
        },
        u.origin,
      ),
      receipt = token();
    await write("private/tests/" + (await hash(receipt)) + ".json", {
      g,
      pid,
      size: b.size,
      sha256: b.sha256,
      rootId: root.id,
      created_at: now,
      status: "upload-pending",
    });
    return json({ ...session, receipt });
  }
  const receipt = u.searchParams.get("receipt") || "";
  if (!/^[a-f0-9]{64}$/.test(receipt)) return fail("Invalid test receipt.");
  const key = "private/tests/" + (await hash(receipt)) + ".json",
    test = await read(key);
  if (!test || now - test.created_at > 86400000) return fail("Test expired.");
  if (u.pathname === "/api/admin/drive/test-download" && req.method === "GET") {
    const driveOriginal = await verifyOriginal(test.g, test.pid);
    test.driveOriginal = driveOriginal;
    test.status = "download-pending";
    await write(key, test);
    return originalDownload(req, test.g, {
      id: test.pid,
      filename: "drive-storage-test.bin.jpg",
      driveOriginal,
    });
  }
  if (u.pathname === "/api/admin/drive/test-result" && req.method === "POST") {
    const b = await req.json();
    test.status =
      b.ok === true && b.size === test.size && b.sha256 === test.sha256
        ? "passed"
        : "failed";
    test.finished_at = now;
    test.diagnostics = {
      ok: test.status === "passed",
      size_matches: b.size === test.size,
      sha256_matches: b.sha256 === test.sha256,
      direct_upload: b.direct_upload === true,
      error: String(b.error || "").slice(0, 300),
    };
    await write(key, test);
    return json({
      status: test.status,
      diagnostics: test.diagnostics,
      receipt,
    });
  }
  if (u.pathname === "/api/admin/drive/test-status" && req.method === "GET")
    return json({
      status: test.status,
      created_at: test.created_at,
      finished_at: test.finished_at,
      diagnostics: test.diagnostics,
    });
  return fail("Not found.", 404);
}

async function digestStream(stream) {
  const reader = stream.getReader(),
    sha = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      sha.update(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { size, sha256: sha.digest("hex") };
}
async function migrationCheck(g, photo, original, expected) {
  await privateJobFolder(original.folder, g);
  const f = privatePersonal(await driveMeta(original.id));
  if (
    f.parents?.length !== 1 ||
    f.parents[0] !== original.folder ||
    f.name !== photo.filename ||
    f.mimeType !== original.mimeType ||
    f.size !== String(expected.size) ||
    f.sha256Checksum !== expected.sha256 ||
    f.appProperties?.broachJob !== g.id ||
    f.appProperties?.broachPhoto !== photo.id
  )
    throw Error("Drive copy does not match the original. No files deleted.");
  const r = await driveFetch(
      "https://www.googleapis.com/drive/v3/files/" + f.id + "?alt=media",
    ),
    d = await digestStream(r.body);
  if (d.size !== expected.size || d.sha256 !== expected.sha256)
    throw Error("Drive download verification failed. No files deleted.");
  return f;
}
async function copyLegacyOriginal(g, photo, key) {
  if (!photo.original) return { already_migrated: !!photo.driveOriginal };
  const source = await get(photo.original, { ...opts, useCache: false });
  if (!source) throw Error("Existing original is missing. No files deleted.");
  const expected = await digestStream(source.stream),
    mimeType = source.blob.contentType;
  if (photo.driveOriginal) {
    await migrationCheck(g, photo, photo.driveOriginal, expected);
    photo.migrationVerified = {
      source: photo.original,
      ...expected,
      at: Date.now(),
    };
    await write(key, g);
    return { already_copied: true, size: expected.size };
  }
  const folder = await driveFolder(g),
    pendingPath = `private/migrations/${g.id}/${photo.id}.json`;
  let pending = await read(pendingPath);
  if (pending) {
    if (
      pending.size !== expected.size ||
      pending.sha256 !== expected.sha256 ||
      pending.folderId !== folder.id ||
      pending.source !== photo.original
    )
      throw Error(
        "Original or folder changed during migration. No files deleted.",
      );
    const r = await fetch(
      "https://www.googleapis.com/drive/v3/files/" +
        pending.fileId +
        "?fields=" +
        encodeURIComponent(driveFields),
      { headers: { Authorization: "Bearer " + (await driveToken()) } },
    );
    if (r.ok) {
      const o = {
        id: pending.fileId,
        folder: folder.id,
        ...expected,
        mimeType,
      };
      await migrationCheck(g, photo, o, expected);
      photo.driveOriginal = o;
      photo.migrationVerified = {
        source: photo.original,
        ...expected,
        at: Date.now(),
      };
      await write(key, g);
      await del(pendingPath);
      return { copied: true, size: expected.size };
    }
    if (r.status !== 404)
      throw Error("Could not inspect the earlier migration. No files deleted.");
    if (pending.session) {
      const q = await fetch(await unseal(pending.session), {
        method: "PUT",
        headers: { "Content-Range": "bytes */" + expected.size },
        body: new Uint8Array(0),
      });
      if (q.status !== 404 && q.status !== 410)
        throw Error(
          "Earlier migration is incomplete. It must be inspected before retrying. No files deleted.",
        );
    }
  }
  const ids = await (
      await driveFetch(
        "https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files",
      )
    ).json(),
    fileId = ids.ids[0];
  const begin = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=" +
      encodeURIComponent(driveFields),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(expected.size),
      },
      body: JSON.stringify({
        id: fileId,
        name: photo.filename,
        mimeType,
        parents: [folder.id],
        appProperties: { broachJob: g.id, broachPhoto: photo.id },
      }),
    },
  );
  const session = begin.headers.get("Location");
  if (!session || new URL(session).origin !== "https://www.googleapis.com")
    throw Error("Migration session failed.");
  await write(pendingPath, {
    fileId,
    folderId: folder.id,
    ...expected,
    source: photo.original,
    session: await seal(session),
  });
  const again = await get(photo.original, { ...opts, useCache: false });
  if (!again) throw Error("Original is no longer available. No files deleted.");
  const sha = createHash("sha256");
  let count = 0;
  const body = again.stream.pipeThrough(
    new TransformStream({
      transform(chunk, c) {
        count += chunk.byteLength;
        sha.update(chunk);
        c.enqueue(chunk);
      },
    }),
  );
  const uploaded = await fetch(session, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(expected.size),
    },
    body,
    duplex: "half",
  });
  if (!uploaded.ok) throw Error("Original copy stopped. No files deleted.");
  if (count !== expected.size || sha.digest("hex") !== expected.sha256)
    throw Error("Original changed while copying. No files deleted.");
  const o = { id: fileId, folder: folder.id, ...expected, mimeType };
  await migrationCheck(g, photo, o, expected);
  photo.driveOriginal = o;
  photo.migrationVerified = {
    source: photo.original,
    ...expected,
    at: Date.now(),
  };
  await write(key, g);
  await del(pendingPath);
  return { copied: true, size: expected.size };
}
async function removeLegacyOriginal(g, photo, key) {
  const oldPath = photo.original || photo.legacy_delete_pending;
  if (!oldPath) return { already_removed: true };
  if (!photo.driveOriginal) throw Error("Verify a Drive copy first.");
  const expected = {
    size: photo.driveOriginal.size,
    sha256: photo.driveOriginal.sha256,
  };
  await migrationCheck(g, photo, photo.driveOriginal, expected);
  const source = await get(oldPath, { ...opts, useCache: false });
  if (source) {
    const old = await digestStream(source.stream);
    if (old.size !== expected.size || old.sha256 !== expected.sha256)
      throw Error("Original copies differ. No files deleted.");
  } else if (photo.original)
    throw Error(
      "Legacy original missing; inspect before removing its reference.",
    );
  photo.original = null;
  photo.legacy_delete_pending = oldPath;
  photo.original_migrated_at = Date.now();
  await write(key, g);
  if (source) await del(oldPath);
  const remains = await get(oldPath, { ...opts, useCache: false });
  if (remains) {
    await remains.stream.cancel();
    throw Error("Host copy removal is pending. Safe to retry.");
  }
  photo.legacy_delete_pending = null;
  await write(key, g);
  return { removed: true, size: expected.size };
}
function legacyPhoto(p) {
  return !!(p.original || p.legacy_delete_pending);
}
function verifiedLegacy(p) {
  return !!(
    p.driveOriginal &&
    p.migrationVerified &&
    p.migrationVerified.source === (p.original || p.legacy_delete_pending) &&
    p.migrationVerified.size === p.driveOriginal.size &&
    p.migrationVerified.sha256 === p.driveOriginal.sha256
  );
}
async function migrationStatus() {
  const jobs = [];
  for (const item of await allBlobs("jobs/")) {
    const g = await read(item.pathname);
    if (g) jobs.push(g);
  }
  const originals = jobs.flatMap((g) =>
    g.photos
      .filter(legacyPhoto)
      .map((p) => ({
        jobId: g.id,
        photoId: p.id,
        copied: !!p.driveOriginal,
        verified: verifiedLegacy(p),
      })),
  );
  return {
    originals: originals.length,
    copied: originals.filter((p) => p.copied).length,
    verified: originals.filter((p) => p.verified).length,
    ready_to_remove: originals.length > 0 && originals.every((p) => p.verified),
    items: originals,
  };
}

async function deleteGallery(g, key) {
  if (
    !/^[a-f0-9-]{36}$/.test(g.id) ||
    key !== "jobs/" + (await hash(g.token)) + ".json"
  )
    throw Error("Invalid gallery record.");
  const prefixes = [
    `media/${g.id}/`,
    `picks/${g.id}/`,
    `comments/${g.id}/`,
    `watermarks/${g.id}/`,
    `views/${g.id}/`,
    `activity/${g.id}/`,
    `private/uploads/${g.id}/`,
    `private/migrations/${g.id}/`,
  ];
  const paths = (await Promise.all(prefixes.map(allBlobs)))
    .flat()
    .map((x) => x.pathname);
  paths.push(`notified/${g.id}.json`);
  for (const photo of g.photos) {
    for (const path of [
      photo.proof,
      photo.original,
      photo.legacy_delete_pending,
    ])
      if (path) {
        if (!path.startsWith(`media/${g.id}/`))
          throw Error(
            "Stored photo belongs to another gallery. No files deleted.",
          );
        paths.push(path);
      }
  }
  if (g.preview) {
    if (!g.preview.startsWith(`media/${g.id}/`))
      throw Error("Preview belongs to another gallery.");
    paths.push(g.preview);
  }
  const pending = (
    await Promise.all(
      paths
        .filter(
          (p) =>
            p.startsWith(`private/uploads/${g.id}/`) ||
            p.startsWith(`private/migrations/${g.id}/`),
        )
        .map(read),
    )
  ).filter(Boolean);
  const saved = await read("private/google-drive.json");
  let driveIds = new Set(
      [
        ...g.photos.map((p) => p.driveOriginal?.id),
        ...pending.map((p) => p.fileId),
      ].filter(Boolean),
    ),
    folders = [];
  if (saved) {
    const q = `trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='broachFolder' and value='${g.id}' }`;
    let page;
    do {
      const u = new URL("https://www.googleapis.com/drive/v3/files");
      u.search = new URLSearchParams({
        q,
        fields: "files(" + driveFields + "),nextPageToken",
        pageSize: "1000",
        ...(page ? { pageToken: page } : {}),
      });
      const data = await (await driveFetch(u.href)).json();
      folders.push(...data.files);
      page = data.nextPageToken;
    } while (page);
    for (const folder of folders) {
      await privateJobFolder(folder.id, g);
      let page;
      do {
        const u = new URL("https://www.googleapis.com/drive/v3/files");
        u.search = new URLSearchParams({
          q: `trashed=false and '${folder.id}' in parents`,
          fields: "files(" + driveFields + "),nextPageToken",
          pageSize: "1000",
          ...(page ? { pageToken: page } : {}),
        });
        const data = await (await driveFetch(u.href)).json();
        for (const f of data.files) {
          privatePersonal(f);
          if (
            f.appProperties?.broachJob !== g.id ||
            f.mimeType === "application/vnd.google-apps.folder"
          )
            throw Error(
              "Unrelated file in gallery originals folder. Nothing deleted.",
            );
          driveIds.add(f.id);
        }
        page = data.nextPageToken;
      } while (page);
    }
  } else if (driveIds.size)
    throw Error("Reconnect Google Drive before deleting this gallery.");
  const live = [];
  for (const id of driveIds) {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw Error("Invalid original reference.");
    const r = await fetch(
      "https://www.googleapis.com/drive/v3/files/" +
        id +
        "?fields=" +
        encodeURIComponent(driveFields),
      { headers: { Authorization: "Bearer " + (await driveToken()) } },
    );
    if (r.status === 404) continue;
    if (!r.ok) throw Error("Could not verify original before deletion.");
    const f = privatePersonal(await r.json());
    if (f.appProperties?.broachJob !== g.id || f.parents?.length !== 1)
      throw Error("Original belongs to another gallery. Nothing deleted.");
    await privateJobFolder(f.parents[0], g);
    live.push(id);
  }
  g.deleting = true;
  g.published = false;
  await write(key, g);
  for (const id of [...live, ...folders.map((f) => f.id)]) {
    const auth = { Authorization: "Bearer " + (await driveToken()) },
      url = "https://www.googleapis.com/drive/v3/files/" + id;
    const r = await fetch(url, { method: "DELETE", headers: auth });
    if (!r.ok && r.status !== 404)
      throw Error(
        "Original deletion stopped. Gallery is offline; retry deletion.",
      );
    const check = await fetch(url + "?fields=id", { headers: auth });
    if (check.status !== 404)
      throw Error("Original deletion not confirmed. Retry deletion.");
  }
  for (const path of new Set(paths)) {
    await del(path);
    const remains = await get(path, { ...opts, useCache: false });
    if (remains) {
      await remains.stream.cancel();
      throw Error("Gallery file deletion not confirmed. Retry deletion.");
    }
  }
  await del(key);
  const remains = await get(key, { ...opts, useCache: false });
  if (remains) {
    await remains.stream.cancel();
    throw Error("Gallery record deletion not confirmed. Retry deletion.");
  }
  return { deleted: true, id: g.id };
}

async function route(req) {
  const u = new URL(req.url),
    p = u.pathname,
    method = req.method,
    now = Date.now();
  if (p === "/api/app/setup-status" && method === "GET") {
    return json({
      ownerEmail: ownerEmail(),
      origin: appOrigin(),
      hosting: !!process.env.BLOB_READ_WRITE_TOKEN,
      session: !!process.env.SESSION_SECRET,
      google: !!(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ),
      password: process.env.BLOB_READ_WRITE_TOKEN
        ? !!(await credentials()).hash
        : false,
    });
  }
  if (p === "/api/app/branding" && method === "GET") {
    const b = await read("private/branding.json");
    return json({ logo: b?.version ? "/api/app/logo?v=" + b.version : null });
  }
  if (p === "/api/app/logo" && method === "GET") {
    const b = await read("private/branding.json");
    if (!b?.path) return fail("No custom logo.", 404);
    const object = await get(b.path, { ...opts, useCache: false });
    if (!object) return fail("Logo unavailable.", 404);
    return new Response(object.stream, {
      headers: {
        "Content-Type": b.type,
        "Cache-Control": "public,max-age=60",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  }
  if (p === "/api/app/privacy" && method === "GET")
    return new Response(
      '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy | Contact Sheet</title><main style="font:20px/1.6 Arial,sans-serif;max-width:760px;margin:32px auto;padding:24px;color:#171717"><h1>Contact Sheet privacy</h1><p>Contact Sheet is a private photo delivery and selection service. Last updated October 9, 2026.</p><h2>Google Drive connection</h2><p>Only the gallery owner can connect the approved Google account. The app requests the account email to verify it and limited Drive access (drive.file) for files created by or selected for this app, not access to the whole Drive.</p><p>The Drive storage feature keeps original photographs in private app-created folders. It does not make files public or give clients Google access tokens. Clients with a private gallery link can download originals only when the owner enables downloads. The app passes download bytes through without storing another original copy on its host.</p><p>The Drive feature is being introduced. Existing originals stored with the gallery host are copied and verified before those stored copies are removed. Connecting Google alone does not move or delete files.</p><h2>Admin password and recovery</h2><p>The owner can change the password in admin. Recovery verifies the approved Google account email and allows choosing a new password. Passwords are stored as salted hashes. Changing the password signs other admin sessions out. Recovery does not move photographs or change the Drive connection.</p><h2>Gallery data and access</h2><p>Small display proofs, gallery settings, shared hearts and notes are stored privately with the gallery host. Anyone with a published private gallery link can view the gallery and edit its shared selections and notes. Keep those links private. Activity records cannot prove which person used a link.</p><h2>Use and retention</h2><p>Google user data is used only for the gallery storage and delivery features the owner requests. It is not sold, used for advertising, or used to train AI models. Google connection credentials are encrypted and kept server-side. The owner\'s Google Drive and the gallery\'s hosting services process the data needed to operate these features.</p><p>Photographs and gallery records remain until the owner removes them. The owner can revoke this app\'s access in Google Account connections at any time. Revocation stops future Drive access; it does not delete files already in Drive. The owner can also remove files directly from Drive, which makes those downloads unavailable.</p><h2>Questions</h2><p>Contact the gallery owner through the same channel that provided your gallery link.</p><p><a href="/admin">Gallery admin</a></p></main></html>',
      {
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "public,max-age=300",
        },
      },
    );
  if (p === "/api/admin/recovery" && method === "GET") return recovery(req, u);
  if (p.startsWith("/api/admin/drive/test")) return driveTest(req, u);
  if (p.startsWith("/api/admin/drive/")) return driveOAuth(req, u);
  if (method === "GET" && p === "/api/app/icon")
    return new Response(await readFile(new URL("../src/photos/app-icon.png", import.meta.url)), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public,max-age=86400",
      },
    });
  if (method === "GET" && p === "/api/app/manifest")
    return new Response(
      JSON.stringify({
        name: "Contact Sheet",
        short_name: "Contact Sheet",
        start_url: "/admin",
        scope: "/",
        display: "standalone",
        background_color: "#f3f3f3",
        theme_color: "#f3f3f3",
        icons: [
          {
            src: "/api/app/icon?v=2",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      }),
      { headers: { "Content-Type": "application/manifest+json" } },
    );
  if (
    ["PUT", "POST", "PATCH", "DELETE"].includes(method) &&
    p != "/api/admin/upload" &&
    !sameOrigin(req)
  )
    return fail("Invalid request origin.", 403);
  if (p === "/api/notifications/access") {
    if (method === "GET")
      return new Response(
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gallery activity feed</title><form method="post"><label>Feed access token<input type="password" name="token" autocomplete="current-password"></label><button>Open feed</button></form>',
        {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        },
      );
    if (method === "POST") {
      const b = await req.formData(),
        secret = process.env.NOTIFICATION_FEED_TOKEN;
      if (!secret || !equal(String(b.get("token") || ""), secret))
        return fail("Access denied.", 401);
      const exp = String(now + 86400000);
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/api/admin/notifications",
          "Set-Cookie": `broach_feed=${exp}.${await sign(exp, secret)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
          "Cache-Control": "no-store",
        },
      });
    }
  }
  if (p === "/api/admin/recovery/status" && method === "GET")
    return json({ ready: !!(await recoveryValid(req)) });
  if (p === "/api/admin/password" && method === "POST")
    return changePassword(req, false);
  if (p === "/api/admin/recovery/reset" && method === "POST")
    return changePassword(req, true);
  if (p === "/api/admin/login" && method === "POST") {
    if (!(await credentials()).hash || !process.env.SESSION_SECRET)
      return fail("Admin not configured.", 503);
    const ip = await hash(req.headers.get("x-forwarded-for") || "local"),
      attempt = await read("attempts/" + ip + ".json");
    if (attempt && attempt.reset > now && attempt.count >= 5)
      return fail("Wait 15 minutes before retrying.", 429);
    const { password, remember } = await req.json();
    if (typeof password !== "string" || password.length > 256)
      return fail("Invalid login.", 401);
    const auth = await credentials();
    if (!equal(await passwordHash(password, auth.salt), auth.hash)) {
      await write("attempts/" + ip + ".json", {
        count: attempt?.reset > now ? attempt.count + 1 : 1,
        reset: now + 900000,
      });
      return fail("Invalid login.", 401);
    }
    await del("attempts/" + ip + ".json");
    const ttl = remember === true ? 2592000 : 86400;
    const exp = String(now + ttl * 1000);
    return new Response("{}", {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `broach_admin=${exp}.${await sign(exp, await sessionSecret())}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ttl}`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (p === "/api/admin/upload" && method === "POST") {
    const body = await req.json();
    if (
      body.type === "blob.generate-client-token" &&
      (!sameOrigin(req) || !(await admin(req)))
    )
      return fail("Sign in.", 401);
    return json(
      await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (path, client) => {
          const b = JSON.parse(client || "{}"),
            g = await job(b.token);
          if (
            !g ||
            g.id !== b.id ||
            !path.startsWith(`media/${g.id}/`) ||
            !/^media\/[a-f0-9-]+\/[a-f0-9-]+\/(proof)$/.test(path)
          )
            throw Error("Invalid upload path");
          return {
            allowedContentTypes: [
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/tiff",
            ],
            maximumSizeInBytes: path.endsWith("/proof")
              ? 8 * 1024 * 1024
              : 80 * 1024 * 1024,
            addRandomSuffix: false,
            allowOverwrite: false,
            validUntil: now + 600000,
          };
        },
        onUploadCompleted: async () => {},
      }),
    );
  }
  if (p.startsWith("/api/admin/")) {
    if (
      !(await admin(req)) &&
      !(
        (p === "/api/admin/notifications" ||
          p === "/api/admin/notifications/ack") &&
        (await feedAuth(req))
      )
    )
      return fail("Sign in.", 401);
    if (p === "/api/admin/gallery-defaults" && method === "GET") {
      const d = await read("private/gallery-defaults.json");
      return json({ website: d?.website ?? "" });
    }
    if (p === "/api/admin/gallery-defaults" && method === "PATCH") {
      const b = await req.json();
      let website;
      try {
        website = websiteLink(b.website);
      } catch (e) {
        return fail(e.message, 400);
      }
      await write("private/gallery-defaults.json", { website });
      return json({ website });
    }
    if (p === "/api/admin/branding" && method === "GET") {
      const b = await read("private/branding.json");
      return json({ logo: b?.version ? "/api/app/logo?v=" + b.version : null });
    }
    if (p === "/api/admin/branding/logo" && method === "PUT") {
      const type = req.headers.get("content-type"),
        bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length < 12 || bytes.length > 2 * 1024 * 1024)
        return fail("Use a logo under 2 MB.");
      const hex = Buffer.from(bytes.slice(0, 12)).toString("hex"),
        ascii = Buffer.from(bytes.slice(0, 12)).toString("ascii");
      const valid =
        (type === "image/png" && hex.startsWith("89504e470d0a1a0a")) ||
        (type === "image/jpeg" && hex.startsWith("ffd8ff")) ||
        (type === "image/gif" &&
          (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a"))) ||
        (type === "image/webp" &&
          ascii.startsWith("RIFF") &&
          ascii.slice(8, 12) === "WEBP");
      if (!valid) return fail("Use a PNG, JPEG, GIF or WebP image.");
      const version = token(),
        path = "branding/logo-" + version;
      await put(path, bytes, {
        ...opts,
        addRandomSuffix: false,
        contentType: type,
      });
      const old = await read("private/branding.json");
      await write("private/branding.json", { path, type, version });
      if (old?.path) await del(old.path);
      return json({ logo: "/api/app/logo?v=" + version });
    }
    if (p === "/api/admin/branding/logo" && method === "DELETE") {
      const old = await read("private/branding.json");
      await del("private/branding.json");
      if (old?.path) await del(old.path);
      return json({ logo: null });
    }
    if (p === "/api/admin/migration-status" && method === "GET")
      return json(await migrationStatus());
    if (p === "/api/admin/notifications" && method === "GET")
      return json({ rows: await notices(), quiet_window_ms: 10800000 });
    if (p === "/api/admin/notifications/ack" && method === "POST") {
      const b = await req.json();
      if (
        !/^[a-f0-9-]{36}$/.test(b.job_id) ||
        !Number.isFinite(b.cutoff) ||
        b.cutoff > now
      )
        return fail("Invalid acknowledgement.");
      const old = await read(`notified/${b.job_id}.json`);
      if (old && b.cutoff <= old.cutoff) return json({ ok: true });
      await write(`notified/${b.job_id}.json`, {
        cutoff: b.cutoff,
        last_notified_at: now,
      });
      return json({ ok: true });
    }
    if (p === "/api/admin/logout")
      return new Response("{}", {
        headers: {
          "Set-Cookie":
            "broach_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
        },
      });
    if (p === "/api/admin/galleries" && method === "POST") {
      const b = await req.json();
      if (
        typeof b.title !== "string" ||
        !b.title.trim() ||
        b.title.length > 100
      )
        return fail("Enter a title under 100 characters.");
      let website;
      try {
        website = websiteLink(
          typeof b.website === "string"
            ? b.website
            : ((await read("private/gallery-defaults.json"))?.website ?? ""),
        );
      } catch (e) {
        return fail(e.message, 400);
      }
      const t = token(),
        g = {
          id: crypto.randomUUID(),
          title: b.title.trim(),
          client: String(b.client || "").slice(0, 160),
          downloads: b.high_res === true && b.downloads === true,
          high_res: b.high_res === true,
          selling: false,
          published: false,
          photographer: String(b.photographer || "")
            .trim()
            .slice(0, 100),
          website,
          show_website: b.show_website !== false && !!website,
          theme: ["dark", "light", "masonry"].includes(b.theme)
            ? b.theme
            : "dark",
          created_at: now,
          photos: [],
          token: t,
        };
      await write("jobs/" + (await hash(t)) + ".json", g);
      await write("private/gallery-defaults.json", { website });
      return json({ ...g, path: clientPath(g), original_path: "/p/" + t }, 201);
    }
    if (p === "/api/admin/galleries" && method === "GET") {
      const b = await list({ prefix: "jobs/", limit: 1000 });
      const rows = await Promise.all(
        b.blobs.map(async (x) => {
          const g = await read(x.pathname);
          const picks = await getPicks(g);
          return {
            ...g,
            ...(await galleryViews(g)),
            path: clientPath(g),
            original_path: "/p/" + g.token,
            photo_count: g.photos.length,
            heart_count: picks.filter((x) => x.hearted).length,
          };
        }),
      );
      return json(rows.sort((a, b) => b.created_at - a.created_at));
    }
    const m = p.match(
      /^\/api\/admin\/galleries\/([a-f0-9-]+)\/(photos|original-session|migration-copy|migration-remove|preview|publish|unpublish|picks|settings|title|delete)$/,
    );
    if (!m) return fail("Not found.", 404);
    const b = [
      "photos",
      "original-session",
      "migration-copy",
      "migration-remove",
      "settings",
      "title",
    ].includes(m[2])
      ? await req.json()
      : null;
    const all = await list({ prefix: "jobs/", limit: 1000 });
    let g, key;
    for (const item of all.blobs) {
      const value = await read(item.pathname);
      if (value.id === m[1]) {
        g = value;
        key = item.pathname;
        break;
      }
    }
    if (!g) return fail("Not found.", 404);
    if (m[2] === "delete" && method === "POST") {
      const b = await req.json();
      if (b.confirm !== g.id)
        return fail("Confirm this gallery before deleting.", 400);
      return json(await deleteGallery(g, key));
    }
    if (g.deleting)
      return fail("Gallery deletion is pending. Retry Delete gallery.", 409);
    if (
      ["migration-copy", "migration-remove"].includes(m[2]) &&
      method === "POST"
    ) {
      const photo = g.photos.find((x) => x.id === b.photoId);
      if (!photo) return fail("Photograph not found.", 404);
      if (
        m[2] === "migration-remove" &&
        !(await migrationStatus()).ready_to_remove &&
        legacyPhoto(photo)
      )
        return fail(
          "Copy and verify every original first. No files deleted.",
          409,
        );
      return json(
        await (m[2] === "migration-copy"
          ? copyLegacyOriginal(g, photo, key)
          : removeLegacyOriginal(g, photo, key)),
      );
    }
    if (m[2] === "original-session" && method === "POST") {
      if (g.high_res === false)
        return fail("High-res uploads are disabled for this gallery.", 403);
      return json(await originalSession(g, b, u.origin));
    }
    if (m[2] === "title" && method === "PATCH") {
      const photo = g.photos.find((x) => x.id === b.photoId);
      if (!photo || typeof b.title !== "string" || b.title.length > 160)
        return fail("Invalid image title.");
      photo.title = b.title.trim();
      await write(key, g);
      return json({ ok: true });
    }
    if (m[2] === "photos" && method === "POST") {
      if (g.photos.some((photo) => photo.id === b.photoId))
        return json({ ok: true });
      if (g.photos.length >= 500)
        return fail("This gallery supports up to 500 photographs.");
      const pid = b.photoId;
      if (!/^[a-f0-9-]{36}$/.test(pid)) return fail("Invalid photo.");
      const proof = `media/${g.id}/${pid}/proof`,
        driveOriginal =
          b.hasOriginal && g.high_res !== false
            ? await verifyOriginal(g, pid)
            : null;
      await head(proof);
      g.photos.push({
        id: pid,
        title: String(b.title || "")
          .trim()
          .slice(0, 160),
        filename: String(b.filename).slice(0, 200),
        proof,
        original: null,
        driveOriginal,
      });
      await write(key, g);
      return json({ ok: true });
    }
    if (m[2] === "preview" && method === "PUT") {
      const bytes = await req.arrayBuffer();
      if (
        req.headers.get("content-type") !== "image/png" ||
        bytes.byteLength > 2 * 1024 * 1024
      )
        return fail("PNG under 2 MB required.");
      g.preview = `media/${g.id}/share.png`;
      await put(g.preview, bytes, {
        ...opts,
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: "image/png",
      });
      await write(key, g);
      return json({ ok: true });
    }
    if (m[2] === "publish" && method === "POST") {
      if (!g.photos.length || !g.preview)
        return fail("Upload photos and a share preview first.");
      g.published = true;
      await write(key, g);
      return json({ ok: true });
    }
    if (m[2] === "unpublish" && method === "POST") {
      g.published = false;
      await write(key, g);
      return json({ ok: true });
    }
    if (m[2] === "picks" && method === "GET") {
      const notes = await galleryComments(g);
      return json(
        (await getPicks(g)).map((p) => ({ ...p, comments: notes[p.id] || [] })),
      );
    }
    if (m[2] === "settings" && method === "PATCH") {
      if (
        b.watermark_type !== undefined &&
        !["logo", "text"].includes(b.watermark_type)
      )
        return fail("Choose logo or text.", 400);
      if (
        b.watermark_placement !== undefined &&
        !["corner", "diagonal"].includes(b.watermark_placement)
      )
        return fail("Choose corner or diagonal.", 400);
      if (
        b.watermark_text !== undefined &&
        (typeof b.watermark_text !== "string" || b.watermark_text.length > 100)
      )
        return fail("Keep watermark text under 100 characters.", 400);
      for (const field of [
        "watermark",
        "watermark_type",
        "watermark_placement",
        "watermark_text",
      ])
        if (b[field] !== undefined) {
          if (field === "watermark" && typeof b[field] !== "boolean")
            return fail("Invalid watermark option.", 400);
          g[field] = field === "watermark_text" ? b[field].trim() : b[field];
          g.watermark_version = token();
        }
      for (const field of ["brand_accent", "header_color"]) {
        if (
          b[field] !== undefined &&
          b[field] !== null &&
          !(typeof b[field] === "string" && /^#[0-9a-f]{6}$/i.test(b[field]))
        )
          return fail("Choose a valid six-digit color.", 400);
      }
      if (
        b.header_font !== undefined &&
        b.header_font !== null &&
        !["archivo", "assistant", "serif"].includes(b.header_font)
      )
        return fail("Choose one of the header fonts.", 400);
      for (const field of ["brand_accent", "header_color", "header_font"])
        if (b[field] !== undefined) {
          if (b[field] === null) delete g[field];
          else g[field] = b[field];
        }
      if (
        b.downloads === true &&
        !g.photos.some((photo) => photo.driveOriginal || photo.original)
      )
        return fail(
          "No hi-res originals were uploaded. Use Web size instead.",
          400,
        );
      if (typeof b.web_downloads === "boolean")
        g.web_downloads = b.web_downloads;
      if (typeof b.wax_marks === "boolean") g.wax_marks = b.wax_marks;
      if (["red", "white"].includes(b.wax_color)) g.wax_color = b.wax_color;
      if (typeof b.admin_hidden === "boolean") g.admin_hidden = b.admin_hidden;
      if (typeof b.high_res === "boolean") {
        g.high_res = b.high_res;
        if (!b.high_res) g.downloads = false;
      }
      if (typeof b.downloads === "boolean")
        g.downloads = g.high_res !== false && b.downloads;
      if (typeof b.show_website === "boolean") g.show_website = b.show_website;
      if (typeof b.website === "string") {
        try {
          g.website = websiteLink(b.website);
        } catch (e) {
          return fail(e.message, 400);
        }
        await write("private/gallery-defaults.json", { website: g.website });
      }
      if (typeof b.photographer === "string")
        g.photographer = b.photographer.trim().slice(0, 100);
      if (["dark", "light", "masonry"].includes(b.theme)) g.theme = b.theme;
      await write(key, g);
      return json({ ok: true });
    }
    return fail("Not found.", 404);
  }
  const m = p.match(
    /^\/api\/galleries\/([a-f0-9]{64})(?:\/(picks|media|preview|comments|open)(?:\/([a-f0-9-]+)(?:\/(proof|original|web))?)?)?$/,
  );
  if (m) {
    const g = await job(m[1]);
    if (!g?.published) return fail("Gallery unavailable.", 404);
    const action = m[2];
    if (action === "open" && method === "POST") {
      await write(`views/${g.id}/${Date.now()}-${crypto.randomUUID()}.json`, {
        opened_at: Date.now(),
      });
      return json({ ok: true });
    }
    if (!action && method === "GET") {
      const photos = await publicPhotoState(g);
      return json({
        title: g.title,
        photographer: g.photographer ?? "",
        website: g.show_website === false ? "" : (g.website ?? ""),
        show_website: g.show_website !== false,
        theme: g.theme || "dark",
        brand_accent: g.brand_accent || null,
        header_color: g.header_color || null,
        header_font: g.header_font || null,
        watermark: g.watermark === true,
        watermark_version: g.watermark_version || "",
        downloads:
          g.high_res !== false &&
          g.downloads &&
          g.photos.some((photo) => photo.driveOriginal || photo.original),
        selling: false,
        web_downloads: g.web_downloads === true,
        wax_marks: g.wax_marks === true,
        wax_color: g.wax_color === "white" ? "white" : "red",
        photos,
        selectionMode: "shared-gallery",
      });
    }
    if (action === "picks" && method === "PUT") {
      const b = await req.json(),
        photo = g.photos.find((x) => x.id === b.photoId);
      if (
        !photo ||
        !(
          ["liked", "rejected", "undecided"].includes(b.selection) ||
          typeof b.hearted === "boolean"
        )
      )
        return fail("Invalid pick.");
      const state = ["liked", "rejected", "undecided"].includes(b.selection)
        ? b.selection
        : b.hearted
          ? "liked"
          : "undecided";
      const previous = await read(`picks/${g.id}/${photo.id}.json`);
      await write(`picks/${g.id}/${photo.id}.json`, {
        hearted: state === "liked",
        rejected: state === "rejected",
        updated_at: now,
      });
      if (state === "liked" && !previous?.hearted)
        await activity(g, "heart", photo.id);
      return json({ ok: true, selection: state });
    }
    if (action === "comments") {
      const photo = g.photos.find((x) => x.id === m[3]);
      if (!photo) return fail("Not found.", 404);
      if (method === "GET") return json(await comments(g, photo.id));
      if (method === "POST") {
        const b = await req.json(),
          text = typeof b.text === "string" ? b.text.trim() : "";
        if (!text || text.length > 2000 || !/^[a-f0-9-]{36}$/.test(b.id))
          return fail("Write a note under 2000 characters.");
        const key = `comments/${g.id}/${photo.id}/${b.id}.json`,
          existing = await read(key);
        if (existing) return json(existing);
        if ((await comments(g, photo.id)).length >= 100)
          return fail("This image has reached its 100-note limit.");
        const note = { id: b.id, text, created_at: now };
        await write(key, note);
        await activity(g, "comment", photo.id, b.id);
        return json(note, 201);
      }
    }
    if (action === "media" && method === "GET") {
      const photo = g.photos.find((x) => x.id === m[3]);
      if (!photo) return fail("Not found.", 404);
      if (m[4] === "web" && g.web_downloads !== true)
        return fail("Web-size downloads disabled.", 403);
      if (m[4] === "original" && (g.high_res === false || !g.downloads))
        return fail("Downloads disabled.", 403);
      if (m[4] === "original" && photo.driveOriginal)
        return originalDownload(req, g, photo);
      const path = m[4] === "web" ? photo.proof : photo[m[4]];
      if (!path) return fail("Original not uploaded.", 404);
      if (g.watermark === true && ["proof", "web"].includes(m[4])) {
        const object = await markedProof(g, photo);
        const headers = new Headers({
          "Cache-Control": "private,no-store",
          "Content-Type": "image/jpeg",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        });
        if (m[4] === "web")
          headers.set(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(/\.jpe?g$/i.test(photo.filename || "") ? (photo.filename || "photo.jpg").replace(/(\.[^.]*)$/, "-web$1") : (photo.filename || "photo").replace(/\.[^.]*$/, "") + "-web.jpg")}`,
          );
        return new Response(object.stream, { headers });
      }
      const proof = m[4] === "proof",
        match = proof ? req.headers.get("If-None-Match") : null;
      const object = await get(path, {
        ...opts,
        ...(match ? { headers: { "If-None-Match": match } } : {}),
      });
      if (!object) return fail("File unavailable.", 404);
      const headers = new Headers({
        "Cache-Control": "private,no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      if (proof && object.blob.etag) headers.set("ETag", object.blob.etag);
      if (proof && object.statusCode === 304)
        return new Response(null, { status: 304, headers });
      headers.set("Content-Type", object.blob.contentType);
      if (object.blob.size != null)
        headers.set("Content-Length", String(object.blob.size));
      if (m[4] === "web")
        headers.set(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(/\.jpe?g$/i.test(photo.filename || "") ? (photo.filename || "photo.jpg").replace(/(\.[^.]*)$/, "-web$1") : (photo.filename || "photo").replace(/\.[^.]*$/, "") + "-web.jpg")}`,
        );
      if (m[4] === "original")
        headers.set(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(photo.filename)}`,
        );
      return new Response(object.stream, { headers });
    }
    if (action === "preview" && g.preview) {
      const b = await get(g.preview, opts);
      return new Response(b.stream, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public,max-age=300",
          "X-Robots-Tag": "noindex",
        },
      });
    }
    return fail("Not found.", 404);
  }
  if (/^\/p\/[A-Za-z0-9_-]+$/.test(p)) {
    const id = p.split("/")[2],
      g = await publicJob(id);
    if (!g?.published)
      return new Response("Gallery unavailable.", { status: 404 });
    const t = g.token;
    let html = await readFile(
      new URL("../dist/index.html", import.meta.url),
      "utf8",
    );
    const credit = (g.photographer ?? "").trim(),
      description = escapeHTML(
        credit ? "Photography by " + credit : "View this photo gallery.",
      ),
      title = escapeHTML(g.title),
      cover = g.photos.find((photo) => photo.proof),
      imageURL =
        u.origin +
        "/api/galleries/" +
        t +
        (cover
          ? "/media/" +
            cover.id +
            "/proof?v=photo-cover-1&wm=" +
            encodeURIComponent(g.watermark_version || "")
          : "/preview"),
      img = escapeHTML(imageURL),
      pageURL = escapeHTML(u.origin + p),
      imageAlt = escapeHTML(
        cover ? cover.title || g.title + " cover photo" : g.title,
      );
    const metadata = `${cover ? `<link rel="preload" as="image" href="${escapeHTML(u.origin + "/api/galleries/" + t + "/media/" + cover.id + "/proof")}" fetchpriority="high">` : ""}<meta name="broach-gallery-token" content="${t}"><meta name="robots" content="noindex,nofollow"><meta name="description" content="${description}"><meta property="og:type" content="website"><meta property="og:url" content="${pageURL}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="${img}"><meta property="og:image:secure_url" content="${img}"><meta property="og:image:alt" content="${imageAlt}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${img}"><meta name="twitter:image:alt" content="${imageAlt}">`;
    html = html.replace("</head>", metadata + "</head>");
    html = html.replace(
      "<title>Contact Sheet</title>",
      `<title>${title}${credit ? " | Photography by " + escapeHTML(credit) : ""}</title>`,
    );
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private,no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex,nofollow",
      },
    });
  }
  return fail("Not found.", 404);
}
async function getPicks(g) {
  return Promise.all(
    g.photos.map(async (p) => ({
      ...p,
      ...(await read(`picks/${g.id}/${p.id}.json`)),
    })),
  );
}

export default { fetch: handler };
