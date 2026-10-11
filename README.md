# Web Monitor API on Vercel

## Vercel project settings

- Set **Root Directory** to `web-monitor-server`.
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

Optional values can be copied from `.env.example` as needed. `PORT` is not needed on Vercel; Vercel supplies the serverless request/response lifecycle. Do not paste `.env` values into chat or commit them.

## Important runtime limitation

Vercel functions are short-lived and do not run the persistent Playwright worker or the in-process daily scheduler. The API can accept a run and store checks in MongoDB, but the checks will remain queued until `npm run worker` is running on a separate persistent Node host. Run the worker on a service such as Render, Fly.io, Railway, or a VM, with the same MongoDB URI and compatible monitoring settings. The daily scheduler must also run as a single persistent service or an external scheduled job. Do not deploy multiple scheduler copies.

Screenshots written to the function filesystem are ephemeral. Use object storage (for example, S3-compatible storage) before relying on screenshots in production.

## Local development

From the project root, start the client, API, and Playwright worker together with one command:

```powershell
cd web-monitor-client
npm run dev
```

This starts Vite, the API server, and the monitoring worker in the same terminal. Keep it open while using the dashboard; press Ctrl+C to stop all three. Saving the server's `.env` file automatically restarts the API and worker to load the updated settings; Vite stays running. Quote `.env` values containing `#` (for example, `ADMIN_PASSWORD="your-value"`), because an unquoted `#` starts a comment.

To start services separately, use three terminals:

```powershell
cd web-monitor-client
npm run server
```

```powershell
cd web-monitor-client
npm run worker
```

The client is available at `http://localhost:5173`. Keep the API and worker terminals running while monitoring sites.
The dashboard shows whether the worker heartbeat is online. The worker logs each website as it starts and finishes a check, retries checks left processing by a stopped worker, and reports mobile navigation errors separately.

Websites are displayed in a stable saved order. New rows imported from a Google Sheets tab are appended in the same order as the sheet; importing a URL that already exists updates it without changing its position. Sheet imports detect an optional header row, so a headerless sheet's first website is imported too.

## Local verification

```powershell
npm install
npm run build
npm test
```
