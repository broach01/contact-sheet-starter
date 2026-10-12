# Contact Sheet

A single-owner client photo gallery that runs on your own Vercel and Google Drive accounts. Clients view a private link, mark selections and leave notes. Optional web/hi-res downloads and proof watermarks are included.

## Start here

1. [Fork this repository](https://github.com/broach01/contact-sheet-starter/fork).
2. Import your fork as a new Vercel project.
3. Follow [START-HERE.md](START-HERE.md) for private storage, owner/security settings, Google OAuth and the final real gallery test.

No local terminal is needed for the hosted fork/import route. Desktop is recommended; phone-only account setup has not been verified. This is source software, not a one-click native installer. Setup needs your own hosting and Google accounts. No Dropbox or print checkout is implemented.

The existing ZIP remains another route: https://galleries.broach.photo/pro-contact-sheet.zip

## Local development

Node.js 22+, then `npm ci`, `npm test`, `npm run build`. Tests simulate provider responses and do not prove real hosting or Google consent succeeded. [AI-SETUP.md](AI-SETUP.md) maps the source.

## License

MIT for this starter's code/docs. Bundled fonts retain SIL OFL 1.1; see [THIRD-PARTY.md](THIRD-PARTY.md). No client photographs, passwords or private account credentials are included.
