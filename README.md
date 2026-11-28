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

## Google Analytics 4 and Search Console traffic reports

Traffic Check reads both sources through the Google account already connected for Sheets; no separate service-account key or new environment variable is needed.

Site Check and Domain & Hosting share the `websites` collection. Traffic Check uses the separate `traffic_websites` collection, and the Add / Import dialog's destination tabs apply to manual additions, pasted URL imports, and Google Sheets imports. The same URL can exist in both lists. On first Traffic Check access, mapped or previously reported legacy traffic records are copied into the dedicated collection before Site Check deletions can affect them.

1. In the same Google Cloud project as the OAuth client, enable **Google Analytics Admin API**, **Google Analytics Data API**, and **Google Search Console API**. Keep the Google Sheets API enabled if you also use the results-sheet feature.
2. In Google Auth Platform, add the read-only scopes `https://www.googleapis.com/auth/analytics.readonly` and `https://www.googleapis.com/auth/webmasters.readonly` to the app's Data Access configuration. Existing users must reconnect from **Traffic Check → Update Google permissions** to grant the expanded access. If the OAuth app is in Testing, add the connecting Google account as a test user. Google may expire refresh tokens for external apps left in Testing after seven days; for continuous use, publish the consent screen to Production and complete any verification Google requires.
3. Give that Google account access to the relevant GA4 properties (Viewer or higher) and Search Console properties (Full user or Owner).
4. Open **Traffic Check** and let it discover properties. The dashboard automatically links exact website/property matches; choose the correct GA4 property and Search Console property from the per-website selectors when needed.
5. Set independent GA4 and Search Console date ranges in the **Run all date ranges** panel, then select **Run all checks** to query every eligible active website with those ranges. GA4 quick ranges are Today, 7 days, 28 days, 90 days, and This month; Search Console quick ranges are 24 hours, 7 days, 28 days, and 3 months. Use **Custom** and the date fields for any other range. The Search Console API returns daily totals rather than hourly data, so its 24 hours preset uses yesterday, not a rolling 24-hour window; Google may publish Search Console data with a delay. The automatic daily run remains limited to the current calendar date in `DEFAULT_TIMEZONE` (defaults to `Asia/Dhaka`). The same separate quick ranges and custom date fields are available when updating an individual website; choose **Update this website** to query only that site. The GA4 overview shows actual property sessions, users, page views, top channels, top countries, and comparison with the previous period—not third-party traffic estimates. A Search Console chart plots daily clicks and impressions over its selected date range; hover or use the arrow keys to inspect both values for each date. End dates cannot be later than today in `DEFAULT_TIMEZONE`.

The persistent worker automatically queues one Traffic Check per calendar date, using the current date in `DEFAULT_TIMEZONE`; on startup, it queues today's report if one has not yet been queued. It also refreshes GA4 realtime active users every 10 minutes and stores the refresh timestamp and any property errors. The Traffic Check page polls these saved values while open. Keep exactly one persistent worker deployment running for automatic daily and realtime updates. Traffic runs are queued and processed independently of Site Check and Domain & Hosting; a run can also be started or cancelled from the Traffic Check page. A site with only one property mapped still gets that source's report, while the other source displays its own mapping or API error.

## Important runtime limitation

Vercel functions are short-lived and do not run the persistent Playwright worker. The API can accept a run and store checks in MongoDB, but the checks will remain queued until `npm run worker` is running on a separate persistent Node host. Run the worker on a service such as Render, Fly.io, Railway, or a VM, with the same MongoDB URI and compatible monitoring settings. The daily Traffic Check scheduler runs in that worker; do not deploy multiple worker copies.

Issue screenshot capture is disabled; monitoring results are stored without screenshot files.

## Local development

Run the client, API server, and worker in three separate terminals. The client always proxies API requests to `http://localhost:4000`; it does not start or connect to a live API.

```powershell
cd client
npm run dev
```

```powershell
cd server
npm run dev
```

```powershell
cd server
npm run worker
```

Run the worker command from the `server` directory in the third terminal. Keep all three terminals running while using the dashboard; press Ctrl+C in each to stop its process. The client is available at `http://localhost:5173`. The server and worker load `server/.env`; for fully local data, set `MONGODB_URI=mongodb://127.0.0.1:27017/web_monitor` and have local MongoDB running. Quote `.env` values containing `#` (for example, `ADMIN_PASSWORD="your-value"`), because an unquoted `#` starts a comment.
The dashboard shows whether the worker heartbeat is online. The worker logs each website as it starts and finishes a check, retries checks left processing by a stopped worker, and reports mobile navigation errors separately.

The worker checks both the homepage and the contact/news items in desktop and mobile navigation, opening dropdown menus to find hidden links. It recognizes anchors and buttons in navigation areas, including buttons without a URL, and common contact/news labels in multiple languages, including Portuguese, Spanish, French, Arabic, Japanese, Chinese, Greek, and Bengali. It tries both HTTP and HTTPS homepage variants when the site is reachable over either scheme. Slow successful homepages still get desktop/mobile navigation checks; other homepage failures (including timeout, suspension, verification challenge, HTTP errors, blank content, and SSL failure) skip those checks so they are not reported as missing. Browser verification challenges are reported separately. News links pointing to `/category/news/` are ignored without requesting or validating that category page. A missing News navigation issue is reported only when the same-domain `/news` page exists but no News item is found in that navigation. Contact links are checked the same way, including dropdown and mobile menu cases.

The **Domain & Hosting** dashboard tab runs domain lookups through the persistent worker. It uses public RDAP, DNS, IP-network, and TLS data to show registration dates/registrar, expiry, nameservers, DNS records, visible network/provider and country, and SSL certificate dates. The provider and country describe the publicly resolved network and may show a CDN edge rather than the origin host; registration details may be hidden or unavailable for some domain endings. Domain checks are queued separately from website checks. From the Domain & Hosting tab, run a lookup for one site from its action menu, for all sites, or for marked sites. A running domain run can be cancelled from its progress panel; queued lookups stop, and in-progress lookups do not save their result. Marked sites also have bulk pause/resume and delete controls; these manage the websites themselves and do not start Site Checks. The per-site action menu also provides website actions such as opening the site, copying its URL, pausing/resuming monitoring, and deleting it. A domain lookup never starts a Site Check. The latest domain result is also shown in each website's Site Check details. Keep the persistent worker running for these checks to complete.

The dashboard offers separate Site Check and Domain & Hosting actions. Automatic daily checks are disabled; start either check manually from its own tab. Site Checks cover active websites; Domain & Hosting checks cover the full inventory, including paused websites. Their results are stored and updated independently. If a matching run is already in progress, existing work is reused rather than duplicated.

Contact and News order of checks: after the homepage is healthy, the worker first checks whether `maindomain/contact` or `maindomain/contact-us` exists, then whether `maindomain/news` exists, then looks for the items in the desktop and mobile navbar. Menu items are found **by address, not by text**, so the language of the site does not matter: a link to `maindomain/news` is the News item, and a link to `maindomain/contact` or `maindomain/contact-us` is the Contact item (visible or hidden in a dropdown, "More" box or mobile menu; footer links do not count). The multilingual label match is only a backup for menus whose address is different. Contact is required: a missing Contact menu item is always reported, and the issue says whether the contact page exists. News is different: it is required in the navbar only when `maindomain/news` exists, and the check is skipped when that page does not exist. A News menu item that points to `maindomain/category/news` is skipped without being requested.

Websites are displayed in a stable saved order. New rows imported from a Google Sheets tab are appended in the same order as the sheet; importing a URL that already exists updates it without changing its position. Sheet imports detect an optional header row, so a headerless sheet's first website is imported too. A Google Sheets URL with a `gid` imports that tab; without one, the importer prefers a tab named `All site` or `All sites`, then falls back to the first tab.

## Local verification

```powershell
npm install
npm run build
npm test
```