// src/lib/prisma.js
// Prisma client singleton – avoids multiple connections in dev (hot reload)
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

// ─── Helpers per campi "mese-anno" (dataStipula, dataFine, dataDecorrenza) ───
// Nel DB sono TIMESTAMP(3); l'app li vede sempre come stringhe "MM-YYYY".
// Utilizziamo mezzogiorno UTC (12:00) come valore sicuro per ogni fuso ±12h.

function toMMYYYY(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}-${yyyy}`;
}

function fromMMYYYY(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const match = String(value).trim().match(/^(\d{2})-(\d{4})$/);
  if (!match) return value; // non è MM-YYYY, passa invariato
  const [, mm, yyyy] = match;
  return new Date(Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, 1, 12, 0, 0));
}

// Converte i campi data nel payload di scrittura (create/update/upsert)
function convertContrattoData(data) {
  if (!data || typeof data !== "object") return;
  if ("dataStipula" in data && typeof data.dataStipula === "string")
    data.dataStipula = fromMMYYYY(data.dataStipula);
  if ("dataFine" in data && typeof data.dataFine === "string")
    data.dataFine = fromMMYYYY(data.dataFine);
}
function convertTrattativaData(data) {
  if (!data || typeof data !== "object") return;
  if ("dataDecorrenza" in data && typeof data.dataDecorrenza === "string")
    data.dataDecorrenza = fromMMYYYY(data.dataDecorrenza);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

function createPrismaClient() {
  const isProduction = process.env.NODE_ENV === "production";
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });

  const base = new PrismaClient({ adapter });

  return base.$extends({
    // ── Lettura: Date → "MM-YYYY" ──────────────────────────────────────────
    result: {
      contratto: {
        dataStipula: {
          needs: { dataStipula: true },
          compute: (row) => toMMYYYY(row.dataStipula),
        },
        dataFine: {
          needs: { dataFine: true },
          compute: (row) => toMMYYYY(row.dataFine),
        },
      },
      trattativaMercato: {
        dataDecorrenza: {
          needs: { dataDecorrenza: true },
          compute: (row) => toMMYYYY(row.dataDecorrenza),
        },
      },
    },

    // ── Scrittura: "MM-YYYY" → Date ────────────────────────────────────────
    query: {
      contratto: {
        $allOperations({ args, query }) {
          if (args.data) {
            if (Array.isArray(args.data)) {
              args.data.forEach(convertContrattoData);
            } else {
              convertContrattoData(args.data);
            }
          }
          return query(args);
        },
      },
      trattativaMercato: {
        $allOperations({ args, query }) {
          if (args.data) convertTrattativaData(args.data);
          return query(args);
        },
      },
    },
  });
}

const prisma = global.__prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}

module.exports = prisma;
