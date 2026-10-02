import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // R23: query logging is invaluable locally but noisy + slow on the
    // serverless cloud deployment (every query becomes a log line). Keep it
    // for dev, keep only errors for production (Vercel + packaged desktop).
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
