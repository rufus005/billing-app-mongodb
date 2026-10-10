# Billing API

Install dependencies with `npm ci`, then run `npm run server`.
Local settings are loaded from `.env` in this folder, with `../.env` as a fallback.

## Vercel deployment

This repository contains the backend API, not the billing frontend.
Vercel loads the default Express export in `app.js`; `server.js` is the local launcher.

1. Import this Git repository into Vercel. Set Root Directory to the repository
   root (the folder containing `package.json` and `vercel.json`).
2. Use the Express framework preset. Remove custom Build Command and Output
   Directory overrides; this API does not produce a `dist` or `build` folder.
3. In Project Settings > Environment Variables, configure `MONGO_URI`,
   `JWT_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` for the deployment's
   environment. Local `.env` files are ignored by Git and are not deployed.
4. Set `CLIENT_URL` in the backend Production environment to:
   ```text
   https://billing-app-frontent-git-main-rufus005s-projects.vercel.app,https://billing-app-frontent.vercel.app,https://billing-app-frontent-rufus005s-projects.vercel.app
   ```
   Multiple allowed origins are comma-separated. An unset value permits only
   localhost, which rejects the deployed frontend before login. Add other trusted
   origins explicitly; do not allow all `*.vercel.app` sites.
5. Push the changes and deploy the latest commit. Visit the URL shown for the
   successful deployment. `/` returns API metadata; `/api/health` returns 200
   when MongoDB is connected, or 503 when it is disconnected.

The frontend's own environment must set `VITE_API_URL` to the deployed backend
origin instead of localhost. Redeploy the frontend after changing that value.
If the API responds but MongoDB is disconnected, check the function logs and
the database credentials and Atlas network access rules.

For this frontend, use `VITE_API_URL=https://billing-app-mongodb-9ozg.vercel.app`
without `/api`: the frontend already adds `/api` to its request paths.
Environment changes require a new deployment to take effect. Keep existing
`MONGO_URI`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `JWT_SECRET` unchanged.
No reset, seed, import, or credential rotation is needed.

## Login regression checks

Run `npm test`. Tests use isolated process-only credentials, disable MongoDB,
and verify preflight, origin rejection, login, JWT validation, and protected routes.
Global CORS middleware answers OPTIONS before authentication; no separate Vercel
rewrite or Express 5 wildcard OPTIONS route is needed.

After deployment, OPTIONS `/api/auth/login` from an allowed origin must return
204 with matching `Access-Control-Allow-Origin`; POST with invalid credentials
must return 401 JSON with that same CORS header. Check `/api/health` for MongoDB
connectivity, then log in with the existing admin credentials. A Vercel 404
without `X-Powered-By: Express` points to deployment/domain/root routing rather
than the login handler. The branch frontend URL may require Vercel sign-in;
the public frontend is https://billing-app-frontent.vercel.app.

### Production investigation (2026-10-10)

The backend was already serving Express and POST `/api/auth/login`. Production
was missing `CLIENT_URL`, causing OPTIONS from the frontend to return 400 with
no CORS headers. The reported 404 was not reproducible on the current deployment.
The frontend's production variable and compiled bundle both used the correct
backend origin and appended `/api/auth/login` correctly.

Added the three origins above to backend Production `CLIENT_URL` and redeployed
the existing commit `f7d51d4` as `dpl_EbAy2coMMsXfZWCmbkFLEtm7Znek`.
Live checks passed: OPTIONS 204 for all three origins, invalid login 401 with
CORS headers, and health 200 with MongoDB connected. Existing secrets were
unchanged. The local CORS hardening and tests are additional changes to commit
and deploy; the production configuration fix is already active.

## Business payment settings

Authenticated `GET /api/business-payment` and `PUT /api/business-payment` share
`{ upiId, payeeName, showQrOnInvoices, qrCode }`. Updates preserve omitted fields;
an empty UPI ID or payee name clears it. `showQrOnInvoices` defaults to true for
existing businesses. Send `qrCode` as a PNG, JPEG or WebP base64 data URL (maximum
3 MB decoded), or `removeQrCode: true` to remove the image. Omitted/empty `qrCode`
keeps the current image. Upload and removal cannot be requested together.
Images are stored in MongoDB GridFS; replacement cleans up the previous file.
No database reset or manual migration is required.

The frontend Business Settings form saves these values. Invoice preview and PDF
use saved settings; hiding a QR retains its image for later use. The payee name
is printed alongside the UPI ID. Uploaded QR contents are not regenerated when
the UPI ID changes; replace the image too if its payment destination changes.
