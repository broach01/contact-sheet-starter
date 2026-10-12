import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
writeFileSync("session-secret.txt", randomBytes(32).toString("hex"), {
  mode: 0o600,
});
console.log(
  "Created session-secret.txt. Copy its contents into SESSION_SECRET in Vercel, then delete the file. Do not send it in chat or commit it.",
);
