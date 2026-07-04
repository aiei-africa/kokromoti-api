import { PrismaClient } from "@prisma/client";

// Singleton pattern — one client instance across the whole app, not one
// per file/route. Prevents connection-pool exhaustion under load.
const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
