// r56 — Neon DDL pre-stage for the FloorSpace model (custom floor-plan
// zones). The interrupted r56 session added the model to the local SQLite
// schema only; the cloud plane needs the table BEFORE the r56 code deploys
// (the r30 migration pattern: DDL first, idempotent, exact prisma db push
// shape — quoted camelCase columns, SERIAL id, TIMESTAMP(3)).
//
// Safe to run at any time: the deployed r55 Prisma client does not know the
// table exists, so nothing touches it until the r56 build regenerates.
import { Pool } from 'pg'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })

const ddl = [
  `CREATE TABLE IF NOT EXISTS "floor_spaces" (
    "id" SERIAL PRIMARY KEY,
    "floor_plan_id" INTEGER,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'lounge',
    "position_x" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "position_y" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "width_units" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "depth_units" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "floor_spaces_floor_plan_id_fkey" FOREIGN KEY ("floor_plan_id") REFERENCES "floor_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "floor_spaces_floor_plan_id_idx" ON "floor_spaces"("floor_plan_id")`,
]

const before = await pool.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name='floor_spaces'`)
console.log(`floor_spaces exists before: ${before.rows[0].n === 1 ? 'yes (re-run)' : 'no (first run)'}`)
for (const stmt of ddl) await pool.query(stmt)
const after = await pool.query(`SELECT COUNT(*)::int AS n FROM floor_spaces`)
console.log(`floor_spaces ready — rows: ${after.rows[0].n}`)
await pool.end()
