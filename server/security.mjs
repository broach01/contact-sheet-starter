export const escapeHTML = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const hex = (b) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function hash(s) {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );
}
export function token() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
export function sameOrigin(req) {
  return req.headers.get("origin") === new URL(req.url).origin;
}
export async function sign(s, secret) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(s)));
}
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
export async function validSession(cookie, secret, now = Date.now()) {
  if (!secret || !cookie) return false;
  const [exp, mac] = cookie.split(".");
  return (
    Number(exp) > now &&
    Number(exp) < now + 2592000001 &&
    equal(await sign(exp, secret), mac || "")
  );
}
export async function passwordHash(password, salt) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new TextEncoder().encode(salt),
        iterations: 100000,
        hash: "SHA-256",
      },
      k,
      256,
    ),
  );
}
