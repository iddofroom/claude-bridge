import { neon } from "@neondatabase/serverless";

// Build-time evaluation runs without env. Real DATABASE_URL is required at
// request time, where Neon will throw a clear connection error if missing.
// Don't validate here — that breaks `next build` page-data collection.
const url = process.env.DATABASE_URL || "postgres://placeholder@invalid/db";

export const sql = neon(url);
