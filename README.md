# Web Monitor API on Vercel

## Vercel project settings

- Set **Root Directory** to `server`.
- Use the Express framework preset, or leave framework detection enabled.
- Set the build command to `npm run build` if Vercel does not detect it automatically.
- Leave the output directory empty. The API is deployed from the `api/` function routes.

## Environment variables

Add each variable once for the required Vercel targets. If Vercel says a key already exists for Production and Preview, edit the existing entry or remove the duplicate draft; do not add a second entry with the same key and targets.

Required:

- `MONGODB_URI`: MongoDB Atlas connection string. Configure Atlas network access for the deployed API.
- `JWT_SECRET`: long, random, unique production secret.
- `ADMIN_USER`: production admin username.
- `ADMIN_PASSWORD`: strong, unique production password.
- `CLIENT_ORIGIN`: exact deployed client origin, including `https://`.

If the React client is deployed separately, set `VITE_API_URL` in the client Vercel project to this API deployment's origin (for example, `https://your-api-project.vercel.app`). Set `CLIENT_ORIGIN` in this server project to the client's exact origin.

Optional values can be copied from `.env.example` as needed. Set `MAX_WEBSITES` to at least `1000` in Vercel to allow larger inventories. `PORT` is not needed on Vercel; Vercel supplies the serverless request/response lifecycle. Do not paste `.env` values into chat or commit them.

## Optional Google Sheets results

Website entry and import (single website, bulk URLs, and Google Sheets import) continue to work without Google OAuth. To enable the optional private results sheet:

1. Create a Google OAuth web application client and enable the Google Sheets API.
2. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the API and persistent worker environments.
3. Set `GOOGLE_OAUTH_REDIRECT_URI` to the API callback URL, for example `https://your-api.example.com/api/google-sheets/oauth/callback`, and add that exact URL to the OAuth client's authorized redirect URIs.
4. Set the same three variables in local `server/.env` when testing locally. For local use, register `http://localhost:4000/api/google-sheets/oauth/callback`.
5. Sign in to the dashboard, select **Connect Google account**, then create the results sheet. The sheet is private in the connected account's Drive; the dashboard provides a copy-URL button.

Each results sheet keeps a separate tab for each day, named `YYYY-MM-DD` in the configured default timezone (`Asia/Dhaka` by default). Each tab contains website URL, status, and issue columns. Existing websites and their latest results are included when the sheet is selected; completed future checks update their rows. Healthy checks and checks with only a slow-page warning show `Site OK`. Homepage, SSL, contact, and news problems show `Issue found` with a short summary in the issue column. Choose to create a new results sheet, update the current one, or use an existing spreadsheet URL. For an existing spreadsheet, the API creates today's date-named tab if needed and replaces only that day's result data; older date tabs and other tabs are left unchanged. The tab in the pasted URL is not used as the output tab; the connected Google account needs edit access to the spreadsheet. The account refresh token is encrypted in MongoDB using `JWT_SECRET`; use the same JWT secret for the API and worker. Stopping sync leaves the user's Google Sheet intact.

After making a new or existing sheet active, the dashboard defaults to updating that current sheet on subsequent submissions. Selecting **Create a new sheet** explicitly switches sync to a separate spreadsheet.

## Important runtime limitation

Vercel functions are short-lived and do not run the persistent Playwright worker or the in-process daily scheduler. The API can accept a run and store checks in MongoDB, but the checks will remain queued until `npm run worker` is running on a separate persistent Node host. Run the worker on a service such as Render, Fly.io, Railway, or a VM, with the same MongoDB URI and compatible monitoring settings. The daily scheduler must also run as a single persistent service or an external scheduled job. Do not deploy multiple scheduler copies.

Issue screenshot capture is disabled; monitoring results are stored without screenshot files.

## Local development

From the project root, start the client, API, and Playwright worker together with one command:

```powershell
cd client
npm run dev
```

This starts Vite, the API server, and the monitoring worker in the same terminal. Keep it open while using the dashboard; press Ctrl+C to stop all three. Saving the server's `.env` file automatically restarts the API and worker to load the updated settings; Vite stays running. Quote `.env` values containing `#` (for example, `ADMIN_PASSWORD="your-value"`), because an unquoted `#` starts a comment.
The dev launcher waits for the API to connect to MongoDB and become ready before starting Vite, avoiding initial proxy connection errors.

To start services separately, use three terminals:

```powershell
cd client
npm run server
```

```powershell
cd client
npm run worker
```

The client is available at `http://localhost:5173`. Keep the API and worker terminals running while monitoring sites.
The dashboard shows whether the worker heartbeat is online. The worker logs each website as it starts and finishes a check, retries checks left processing by a stopped worker, and reports mobile navigation errors separately.

The worker checks both the homepage and the contact/news links in desktop and mobile navigation, opening dropdown menus to find hidden links. It recognizes common contact and news labels in multiple languages, including Portuguese, Spanish, French, Arabic, Japanese, Chinese, Greek, and Bengali. It tries both HTTP and HTTPS homepage variants when the site is reachable over either scheme. Slow pages, blank responses, and navigation timeouts are reported as warnings; an unreachable homepage, HTTP 5xx response, or invalid SSL remains critical. News links pointing to `/category/news/` are ignored without requesting or validating that category page. A missing News navigation issue is reported only when the same-domain `/news` page exists but no News item is found in that navigation. Contact links are checked the same way, including dropdown and mobile menu cases.

Websites are displayed in a stable saved order. New rows imported from a Google Sheets tab are appended in the same order as the sheet; importing a URL that already exists updates it without changing its position. Sheet imports detect an optional header row, so a headerless sheet's first website is imported too. A Google Sheets URL with a `gid` imports that tab; without one, the importer prefers a tab named `All site` or `All sites`, then falls back to the first tab.

## Local verification

```powershell
npm install
npm run build
npm test
```
