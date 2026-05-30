# Privacy notice

Last updated: 27/05/2026.

## What this app is, technically

Kujira Investments is **static HTML, CSS, and JavaScript** hosted on GitHub Pages. When you visit it, the files are downloaded to your browser and run locally. There is no server-side application. There is no database we maintain. There is no "account" with us.

## What data we collect

**Nothing.**

There is no analytics script. No telemetry. No error reporting that leaves your browser. No login flow. No cookie set by us. The maintainers cannot see who uses the app, what data is entered into it, or how often you open it.

## Where your data lives

Two places, and only two places:

1. **Your browser's local storage**, on the device you're using right now. This is sandboxed per origin — only this app, in this browser, can read it. Closing the browser tab does not delete it; clearing site data does.
2. **The Google Sheet you created and own.** Only people you explicitly share that sheet with can access it. The Apps Script you deployed is the only path between the app and the sheet, and you own that script too.

A copy of your Google Apps Script Web App URL is stored in your browser's local storage so the app knows where to sync. This URL is the credential — treat it like a password.

## Where your data is sent

When you click *Refresh prices*, *Refresh FX*, or any sync action, the app sends a request to **your own Apps Script URL only**. From there, your script may call:

- **Yahoo Finance** (`query1.finance.yahoo.com`) — to fetch stock and FX prices. Yahoo sees the list of tickers you query.
- **CoinGecko** (`api.coingecko.com`) — to fetch crypto prices. CoinGecko sees the list of coin IDs you query.

These third parties only see the tickers and coin IDs you query, not your balances, names, or any other personal data. The requests go from your script (running in your Google account) directly to them, not through us.

## What you can do to delete your data

- **In your browser**: open **⚙ Settings → Sync** and click **Reset local data**. This wipes the local copy.
- **In your Google Sheet**: delete the sheet from your Google Drive. Empty the trash.
- **In your Apps Script project**: delete the Apps Script project from `script.google.com`. This permanently revokes the Web App URL.

After those three steps, no copy of your data exists anywhere.

## Children's data

This app is not designed for children under 13 and the maintainers do not knowingly collect any data from them (because we do not collect any data from anyone).

## Changes to this notice

If anything material changes, we'll update the date at the top and post a note in the GitHub repository's release notes.

## Contact

Open an issue on the GitHub repository.
