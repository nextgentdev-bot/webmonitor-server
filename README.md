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

## Local verification

```powershell
npm install
npm run build
npm test
```
