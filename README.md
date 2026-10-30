# Philomarket

Philomarket is a points-only prediction market for club questions. Points have no cash value and cannot be redeemed.

## Local preview

Install the app dependencies and start Vite:

```sh
npm install
npm run dev
```

With no Firebase client keys, the development page runs a clearly labeled local preview with sample data in your browser. Trading requires a verified account, so it is unavailable until Firebase is configured.

## Tests

```sh
node --test --experimental-test-module-mocks test/
```

## Firebase setup

The app uses Firebase Authentication (email/password with verification), Cloud Firestore, and Vercel Functions for all server-side reads and writes. Client-side Firestore access is denied by `firestore.rules`.

1. Create a Firebase project on the Spark plan and register a web app.
2. In Authentication, enable **Email/Password**. Keep email verification enabled.
3. Create the default Firestore database and publish `firestore.rules` from the Firebase console.
4. In Project settings → General → Your apps, copy the web app values into `.env.local` using these names:

   ```env
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project-id
   VITE_FIREBASE_APP_ID=...
   ```

5. Generate a service-account key in Project settings → Service accounts. Store its full JSON as `FIREBASE_SERVICE_ACCOUNT_JSON` in Vercel **server-side only**. Never commit or paste this private key into the browser config, a public repository, or chat.
6. Add the production `*.vercel.app` domain under Firebase Authentication → Settings → Authorized domains.

Firebase Spark has free usage quotas; if Firestore exceeds them, it stops until the next quota period unless the project moves to a paid plan. See [Firebase pricing](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans) and [Firestore quotas](https://firebase.google.com/docs/firestore/quotas).

## Server environment variables

Set these in Vercel for Production and Preview (and in `.env.local` for local API testing). Values are provided by a club admin; hosted APIs refuse requests until they are set.

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `PHILOMARKET_ALLOWED_EMAILS`
- `PHILOMARKET_ADMIN_EMAILS`

## Vercel deployment

Vercel Hobby is free for personal, non-commercial projects, subject to its usage limits. Vercel's terms allow Hobby project content to be used for AI training and shared with third parties for product improvement; the account owner can opt out in team settings. Since this app includes club initiates' names, review that setting before publishing. See Vercel's [terms](https://vercel.com/legal/terms), [Hobby plan](https://vercel.com/docs/plans/hobby), and [limits](https://vercel.com/docs/limits).

1. Sign in to Vercel and run `vercel` from this directory, or connect the project in the Vercel dashboard.
2. Set the four `VITE_FIREBASE_*` values and the server environment variables above in the Vercel project's environment variables for Production and Preview.
3. Deploy with `vercel --prod`.

Vercel builds the static app into `dist`; the files under `api/` run as serverless functions.
