// src/services/email.service.js
//
// Servizio centralizzato per l'invio di email transazionali via Gmail SMTP.
// Utilizza le credenziali definite in .env (SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASS, SMTP_FROM). Per Gmail si usa una "App Password" (16 caratteri),
// non la password dell'account Google.
//
// ── Utilizzo da un controller ────────────────────────────────────────────────
//   const { sendEmailToUser } = require("../services/email.service");
//
//   // Invio non-bloccante: l'await è opzionale, la funzione non lancia mai
//   await sendEmailToUser(userId, "Benvenuto in MyFanta!", "<p>Ciao!</p>");
//
//   // Oppure fire-and-forget (senza await) — sicuro perché gli errori vengono
//   // già loggati internamente e non propagati al caller:
//   sendEmailToUser(userId, "Rinnovo approvato", htmlContent);
// ─────────────────────────────────────────────────────────────────────────────

const nodemailer = require("nodemailer");
const prisma     = require("../lib/prisma");

// ── Transporter (inizializzato una sola volta, riutilizzato) ──────────────────
// Port 465 → SSL/TLS diretto (secure: true).
// Port 587 → STARTTLS (impostare secure: false e il transporter esegue upgrade).
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || "smtp.gmail.com",
  port:   parseInt(process.env.SMTP_PORT || "465", 10),
  secure: parseInt(process.env.SMTP_PORT || "465", 10) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── Layout HTML di base ───────────────────────────────────────────────────────
function wrapLayout(htmlContent, recipientName) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin:0; padding:0; background:#f4f7f5; font-family: Arial, sans-serif; }
    .wrapper { max-width:600px; margin:32px auto; background:#fff; border-radius:10px;
               box-shadow:0 2px 12px rgba(26,58,42,.10); overflow:hidden; }
    .header  { background:#1a3a2a; padding:24px 32px; }
    .header h1 { color:#fff; margin:0; font-size:1.3rem; letter-spacing:.5px; }
    .header span { color:#a7d7b8; font-size:.82rem; }
    .body    { padding:28px 32px; font-size:.92rem; color:#374151; line-height:1.6; }
    .footer  { background:#f0fdf4; border-top:1px solid #d1fae5; padding:16px 32px;
               font-size:.75rem; color:#6b7280; text-align:center; }
    a { color:#2d6a4f; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>⚽ MyFanta — Lega Manageriale</h1>
      <span>Notifica automatica</span>
    </div>
    <div class="body">
      ${recipientName ? `<p>Ciao <strong>${recipientName}</strong>,</p>` : ""}
      ${htmlContent}
    </div>
    <div class="footer">
      Hai ricevuto questa email perché sei iscritto alla lega.<br>
      © ${year} MyFanta · Lega Manageriale
    </div>
  </div>
</body>
</html>`;
}

// ── Funzione pubblica principale ──────────────────────────────────────────────
/**
 * Invia un'email a un utente identificato dal suo userId.
 * Recupera l'indirizzo email dal DB, avvolge il contenuto nel layout standard
 * e spedisce via Gmail SMTP.
 *
 * NON lancia mai eccezioni: gli errori vengono loggati su log_azioni con
 * azione="EMAIL_FAILURE" e restituisce { ok: false, error } silenziosamente.
 *
 * @param {number}  userId      - ID dell'utente destinatario (tabella fantapresidenti)
 * @param {string}  subject     - Oggetto dell'email
 * @param {string}  htmlContent - Corpo HTML da iniettare nel layout base
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendEmailToUser(userId, subject, htmlContent) {
  // Verifica configurazione SMTP
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[email.service] SMTP_USER o SMTP_PASS non configurati in .env — invio saltato.");
    return { ok: false, error: "SMTP non configurato" };
  }

  try {
    // 1. Recupera email e nickname dell'utente dal DB
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { email: true, nickname: true },
    });

    if (!user) {
      throw new Error(`Utente id=${userId} non trovato nel database.`);
    }
    if (!user.email) {
      throw new Error(`Utente id=${userId} non ha un indirizzo email.`);
    }

    // 2. Costruisce il messaggio con layout base
    const html = wrapLayout(htmlContent, user.nickname || null);

    // 3. Invia
    const info = await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      user.email,
      subject,
      html,
    });

    console.log(`[email.service] Inviata a ${user.email} (userId=${userId}) — messageId: ${info.messageId}`);
    return { ok: true, messageId: info.messageId };

  } catch (err) {
    // 4. Errore non-bloccante: logga su DB e restituisce { ok: false }
    console.error(`[email.service] Invio fallito userId=${userId}: ${err.message}`);

    try {
      await prisma.log.create({
        data: {
          azione:    "EMAIL_FAILURE",
          entita:    "user",
          entitaId:  userId,
          dettaglio: JSON.stringify({
            subject,
            error:   err.message,
            code:    err.code    || null,
            command: err.command || null,
          }),
          adminId: userId, // mittente tecnico = l'utente coinvolto
        },
      });
    } catch (logErr) {
      // Se anche il log fallisce, almeno lo scriviamo su console
      console.error("[email.service] Impossibile scrivere log EMAIL_FAILURE:", logErr.message);
    }

    return { ok: false, error: err.message };
  }
}

/**
 * Invia un'email a un indirizzo diretto (senza lookup utente nel DB).
 * Utile per email verso indirizzi non ancora registrati (es. inviti).
 *
 * @param {string}  toEmail     - Indirizzo email destinatario
 * @param {string}  subject
 * @param {string}  htmlContent
 * @param {string}  [toName]    - Nome visualizzato nel saluto
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendEmailTo(toEmail, subject, htmlContent, toName) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[email.service] SMTP_USER o SMTP_PASS non configurati in .env — invio saltato.");
    return { ok: false, error: "SMTP non configurato" };
  }

  try {
    const html = wrapLayout(htmlContent, toName || null);
    const info = await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      toEmail,
      subject,
      html,
    });
    console.log(`[email.service] Inviata a ${toEmail} — messageId: ${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[email.service] Invio diretto fallito (${toEmail}): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmailToUser, sendEmailTo };
