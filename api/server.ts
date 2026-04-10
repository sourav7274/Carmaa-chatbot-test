// api/server.ts — Vercel serverless entry point
// Vercel will call this file for all /api/* and /webhook routes.
// The Express app is initialized lazily in server.ts and re-used across warm invocations.
export { default } from '../server.ts';
