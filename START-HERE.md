# Contact Sheet: set up your own copy

This ZIP contains source code for a single-owner web gallery. It is not a Mac or Windows installer. Clients use a private browser link. You own the hosting, proof storage and Google Drive account. No David photographs, galleries, passwords or Google credentials are included.

## Before you start

You need your own GitHub account, Vercel account, personal Google account and Google Cloud project. The hosted app needs a private Vercel Blob store. Google Drive is needed for original uploads and high-resolution downloads. Dropbox is not implemented. Shared Drives are not supported. Check hosting and storage terms before choosing any paid service. Nothing in the ZIP pays for hosting or storage.

## 1. Make your own repository

Use the README Deploy with Vercel button to clone the source into your own GitHub account and start a hosting project. It prompts for OWNER_EMAIL and SESSION_SECRET only. After the first deployment continue with steps 3–7 below. Alternatively, open https://github.com/broach01/contact-sheet-starter and choose Fork. This creates your own source copy in your GitHub account. Do not change David's production app. You can also download the ZIP and upload its contents to a new private repository, as before.

## 2. Import your copy into Vercel (if you used Fork)

In Vercel choose Add New > Project and import YOUR fork. You do not need a local terminal for this hosted route: Vercel installs dependencies and builds the app. Desktop is recommended for the Google and hosting consoles. Phone-only completion has not been verified.

Optional local audit on a computer with Node.js 22+:

```sh
npm ci
npm test
npm run build
```

These check the source and simulated install flow, not real account connections. The build restores bundled font/icon assets from integrity-checked scripts/bundled-assets.json. A plain Vite server is a front-end preview, not the working API. Secrets, node_modules, dist and .vercel do not belong in the repository.

## 3. Create your hosting project and private proof storage

In Vercel choose Add New > Project, import your own repository and use the included Vite configuration. Use Node.js 22 or newer. Build command: `npm run build`; output: `dist`. The included `vercel.json` routes the API and gallery pages and includes assets needed for logo watermarks and the app icon.

Deploy once to get your stable production address. In that project's Storage section create a NEW PRIVATE Vercel Blob store and connect it only to this project. Vercel supplies `BLOB_READ_WRITE_TOKEN`. Do not attach David's or another person's store. Proof images, gallery settings, notes, picks, view counts and encrypted connection records are held in this store.

## 4. Configure owner and security

Add these project environment variables for Production:

| Name | Value |
| --- | --- |
| `OWNER_EMAIL` | Your personal Google account email, lowercase |
| `APP_ORIGIN` | Exact stable `https://your-project.vercel.app` address, no path or trailing slash |
| `SESSION_SECRET` | Unique random secret, at least 32 characters |
| `GOOGLE_CLIENT_ID` | Your own Google OAuth web-client ID |
| `GOOGLE_CLIENT_SECRET` | Your own Google OAuth web-client secret |
| `BLOB_READ_WRITE_TOKEN` | Supplied by your connected private Blob store |

The first-owner setup chooses an admin password after Google verifies you. You do not need `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD_SALT` for this package. Do not set notification-feed credentials; there are no open notifications.

Use a password manager to generate the session secret, or run `node scripts/generate-session-secret.mjs`. That helper writes `session-secret.txt` privately on your computer. Copy its value DIRECTLY into Vercel, delete the local file, and never commit or send it in a message.

## 5. Set up your Google OAuth project

In your Google Cloud project enable Google Drive API. Configure Google Auth Platform with your app name, support and contact email. A personal Gmail account uses an External audience. In Testing, add your OWNER_EMAIL as a test user. Create an OAuth client of type Web application.

The authorized redirect URI must be EXACTLY:

```text
https://your-project.vercel.app/api/admin/drive/callback
```

Use your real stable production host, not this example, a preview deployment or David's host. Paste the client ID and secret directly into Vercel. Redeploy after adding or changing environment variables. Google OAuth setup is a real account step, not something the ZIP can do for you.

## 6. Verify yourself and choose a password

Open your production address plus `/admin`. The setup checklist shows owner, proof storage, session security and Google configuration. "Ready" means configuration is present, not that Google or storage has passed a real connection test.

Choose "Verify my Google account and choose my password", sign in as OWNER_EMAIL, then choose an admin password of at least 12 characters. Save it in your password manager. Other Google identities are refused. Use "Forgot password? Recover with Google" later if needed.

## 7. Verify real storage and the first client gallery

In admin open Google Drive setup and test. Choose Connect Google Drive and approve the permission for app-created files. Run Test Drive storage. It creates a private test folder and 6 MB test file in your Drive. Continue only after it passes.

Upload a small test gallery with your own non-sensitive sample photos. Enable originals if you want to test hi-res. Publish, open the client link in a second browser, mark a heart, mark an X, add a note and confirm the admin shows those changes. Test web-size downloads and optional hi-res downloads. Try watermark text and logo, both placements. Text automatically starts with ©. Web/proof downloads should be marked; hi-res should remain clean. Turning watermark off must restore clean proofs. Delete only your named test gallery when finished.

Do not call installation complete until these live account checks pass. Upload and Drive verification need a running browser window. Closing the window, sleeping the computer or losing network can interrupt uploads; retry controls keep already-completed work.

## Limits and practical notes

- Up to 500 photos per gallery; selected batch under 250 MB; original file under 80 MB. JPEG, PNG or WebP inputs. Export RAW, TIFF and HEIC before upload.
- Browser proofs have a 1500-pixel longest edge at JPEG quality 86. Originals stay in private owner Drive; derived marked proofs use private Blob storage.
- Logo PNG/JPEG/GIF/WebP, up to 2 MB and dimensions under 8000 pixels. SVG uploads are not accepted. Transparent PNG is a good watermark choice. A GIF watermark uses a still frame.
- Anyone with a gallery link can view it and edit its shared selections/notes. There is no per-client login. Keep links within the intended audience.
- The open count is gallery opens with first/last dates, not unique people or forwarding detection. No visitor-identification log or notification is added.
- The ZIP contains no sample client photographs. The default Contact Sheet logo can be replaced in admin.
- Keep SESSION_SECRET stable. Changing it invalidates sessions and makes the saved encrypted Drive connection unreadable; reconnect Drive afterward. Back up your source and do not replace the private Blob store without a migration plan.
- Google External Testing can require frequent reconnects for Drive access. Review publishing/verification requirements for lasting use. Hosting and Google quotas apply to your own accounts.
- This package has no paid print checkout, automatic updates, Dropbox backend or native background uploader.

## Troubleshooting

`npm ci` fails: use Node.js 22+ and the included matching package/lock files. Do not copy a different production lockfile into this ZIP.

Google redirect mismatch: compare APP_ORIGIN, the Google authorized redirect URI and the admin checklist's callback character for character. Redeploy after environment changes.

Wrong Google account: use the exact OWNER_EMAIL account. No second account or shared Drive is allowed.

Admin setup shows missing settings: attach private Blob storage, set the required Production variables and redeploy. Missing storage is not a password problem.

Drive test fails: reconnect Drive, approve the files permission, check capacity and test again before client use.

Web download disabled: choose Web size for that gallery and Save. Hi-res requires originals uploaded and Hi-res selected. Saving settings and publishing a gallery are separate controls.

## What was actually tested (October 11, 2026)

From a fresh extracted source ZIP: npm ci, the included security tests, the included simulated first-owner flow, and Vite production build. Phone/desktop setup pixels were inspected. The simulated flow covers owner/host rejection, password setup and replay rejection, login, first gallery creation, proof registration, publication, marked web bytes, heart/note/view count and the owner-specific Drive consent URL.

NOT tested on a friend's real accounts: GitHub/Vercel signup/import, actual Blob provisioning, Google consent for their OAuth project, real Drive upload/download or real hosted first-gallery use. Those steps above require the owner and remain the final install acceptance test. A simulated test is not proof that those account steps succeeded.

Current provider references:
- https://vercel.com/docs/frameworks/frontend/vite
- https://vercel.com/docs/storage/vercel-blob
- https://vercel.com/docs/plans/hobby
- https://developers.google.com/identity/protocols/oauth2
- https://developers.google.com/identity/protocols/oauth2/web-server
