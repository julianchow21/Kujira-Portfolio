# Kujira Portfolio — Portfolio Tracker

A single-page app that tracks your **net worth in one place**: SGX + US stocks, crypto, real estate, cash, CPF (with full history), salary, and expenses. Forward projections for FIRE and CPF growth. Base currency SGD.

**Your data never leaves your control.** This app is static HTML hosted on GitHub Pages. It can only talk to *your own* Google Sheet, which only you have access to. There is no central server, no shared database, no account to create.

## How it works (30-second version)

1. You create an empty Google Sheet.
2. You paste the backend code into Google Apps Script (one-time, 5 minutes).
3. The app on your browser talks directly to your script. Your data stays in your Google Sheet.
4. We process zero data. There is no "us" — only the static HTML you load from GitHub Pages.

## Setup (full walkthrough)

The app's first-launch wizard walks you through these steps interactively. The version below is for reference.

### Step 1 — Create the Google Sheet

1. Go to **[sheets.new](https://sheets.new)** to create a blank sheet.
2. Name it anything you like, e.g. *My Portfolio Tracker*.

### Step 2 — Paste the backend code

1. In your new sheet: **Extensions → Apps Script**.
2. Delete whatever code is already in `Code.gs`.
3. Open [`Portfolio/apps-script.gs`](./Portfolio/apps-script.gs) from this repo. Copy everything.
4. Paste into `Code.gs`. Click **Save** (or Cmd/Ctrl+S).
5. From the function dropdown at the top, pick **`initOnce`** and click **▶ Run**.
6. Google will ask you to grant permissions. Click **Review permissions**, pick your Google account, click **Advanced** → **Go to (your project name)** if there's a "Google hasn't verified this app" warning (this is normal — it's *your own code*), then **Allow**.
7. The Execution log at the bottom should show `Initialised sheet: Data` and a `Yahoo test:` line with AAPL price data.

### Step 3 — Deploy as a Web App

1. Top right: **Deploy → New deployment**.
2. Click the gear icon next to *Select type* → **Web app**.
3. Description: *My Portfolio Tracker* (or anything).
4. Execute as: **Me**.
5. Who has access: **Anyone**.
6. Click **Deploy**.
7. Copy the **Web app URL** (ends in `/exec`). **This URL is your credential — treat it like a password.**

### Step 4 — Connect the app

1. Open the GitHub Pages site for this app.
2. Go to **⚙ Settings → Sync**.
3. Paste your Web app URL into the field.
4. Click **Save URL**, then **Pull from cloud**.
5. The sync pill at the top should turn green: **Synced**.

That's it. Add a stock, refresh prices, watch it sync to your sheet.

## Updating the backend

If we ship a new version of `Portfolio/apps-script.gs`, you'll need to re-paste it:

1. Open your Apps Script project (from the same Google Sheet → Extensions → Apps Script).
2. Select all in `Code.gs`, delete, paste the new file, save.
3. **Deploy → Manage deployments → ✏ pencil icon → Version: New version → Deploy.**
4. **Don't create a new deployment** — that gives you a new URL and breaks the link to the app.

## Privacy summary

See [PRIVACY.md](./PRIVACY.md) for the full statement. Short version:

- Your data lives in **your browser's local storage** and **your Google Sheet**. Nowhere else.
- We never see your data. There's nothing to delete on our end.
- To delete everything: click *Reset local data* in Settings, then delete your Google Sheet.

## Security summary

See [SECURITY.md](./SECURITY.md) for the threat model and audit checklist. Short version:

- The app's static HTML is locked down with CSP and SRI. A future XSS would still be unable to exfiltrate data to a third-party domain.
- All user input is sanitised (string/number/id checks) before being stored.
- The Apps Script validates payloads against a schema allowlist and caps array/string sizes.
- **You** are responsible for keeping your Apps Script URL secret.

To report a security issue, please open a private security advisory on the GitHub repo or email the maintainer.

## Troubleshooting

**The sync pill stays orange ("Syncing…") forever.**
- Check that your Apps Script Web App is deployed (not just saved). Manage deployments should show one entry with Type: Web app.
- Test the URL directly: paste it into a new browser tab. You should see `{"schema":"kujira-portfolio",...}`.

**Price test returns HTTP 401 from Yahoo.**
- Yahoo locked down their old quote endpoint. Make sure you have the **latest** backend `.txt` — it uses the v8 chart endpoint that doesn't require auth.

**"Schema mismatch" error.**
- The sheet you connected was already used by another Kujira app. Use a fresh sheet, or clear cell A1.

**My data isn't showing up after I add a stock.**
- Open Settings → Diagnostics → Refresh diagnostics. If "Local rows" shows the stock, it's a render issue (please report).
- Check the `Stocks` tab in your Google Sheet — the row should be there.

## File layout

This repo hosts three apps on one GitHub Pages site, each in its own folder. There is no root redirect (it was removed); navigate to each app's path directly.

| Path | Role |
|---|---|
| `Portfolio/` | The Kujira Portfolio app. Top level: `index.html`, `sw.js`, `Docs/`, own CLAUDE.md. Supporting files live in `Worker/`: `app.js`, `kjr-core.js`, `apps-script.gs` (backend for your Code.gs), PWA assets, shared `whale-icon.png`. |
| `Trading/` | Kujira Trading, a separate SPA for MU day-trade tracking. Own CLAUDE.md and docs. |
| `Journal/` | Kujira Journal, the trading-journal app. Own CLAUDE.md and docs. |
| `README.md`, `PRIVACY.md`, `SECURITY.md` | Repo-level docs at root. |
| `PRIVACY.md` | Privacy notice. |
| `SECURITY.md` | Threat model and security policy. |
