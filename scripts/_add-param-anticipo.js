require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

p.parametro.upsert({
  where: { chiave: 'mese_anticipo_scadenze' },
  create: {
    chiave: 'mese_anticipo_scadenze',
    valore: '6',
    descrizione: 'Mese in cui la visualizzazione anni-contratto anticipa la scadenza di 1 anno per la pianificazione rinnovi (6=Giugno)',
  },
  update: {},
}).then(r => console.log('OK:', r.chiave, '=', r.valore))
  .catch(console.error)
  .finally(() => p.$disconnect());
