# Zulu Casino

A React and TypeScript implementation of the Zulu Casino card game.

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm test -- --run
npm run build
```

## Online Matches

Online matches use Clerk for player identity and Neon Postgres for shared game state. Create a Neon database, run [`api/schema.sql`](api/schema.sql) in its SQL editor, and set `DATABASE_URL` to the database connection string in the deployment environment. Keep the URL private; do not commit it. `CLERK_SECRET_KEY` must also be configured for the API routes.

Deploy the app with both environment variables configured. Once both players accept a challenge, either player can choose **Join table**; the first join creates the shared deal and later joins load the same table. Moves are validated by the game engine on the server, with stale revisions rejected and hidden cards withheld from the other player. Local tables and bot modes remain browser-local.

For local online testing, use `vercel dev` with those environment variables available. The plain `npm run dev` command starts Vite only and does not serve the `/api/*` routes.

