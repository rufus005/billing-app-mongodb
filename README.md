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
4. Set `CLIENT_URL` to the frontend origin, such as `https://your-frontend.vercel.app`.
   Multiple allowed origins can be separated by commas. Omit trailing slashes.
5. Push the changes and deploy the latest commit. Visit the URL shown for the
   successful deployment. `/` returns API metadata; `/api/health` returns 200
   when MongoDB is connected, or 503 when it is disconnected.

The frontend's own environment must set `VITE_API_URL` to the deployed backend
origin instead of localhost. Redeploy the frontend after changing that value.
If the API responds but MongoDB is disconnected, check the function logs and
the database credentials and Atlas network access rules.
