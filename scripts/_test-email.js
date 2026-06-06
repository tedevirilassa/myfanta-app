require("dotenv").config();
const { sendEmailTo } = require("../src/services/email.service");

sendEmailTo(
  "dan.te@tiscali.it",
  "Email di prova — MyFanta Lega Manageriale",
  `<p>Questa è un'email di prova inviata dal servizio di notifiche di <strong>MyFanta</strong>.</p>
   <p>Se la stai leggendo, la configurazione SMTP con Gmail è funzionante! ✅</p>`,
  "Danilo"
).then(result => {
  if (result.ok) {
    console.log("✅ Email inviata con successo! messageId:", result.messageId);
  } else {
    console.error("❌ Invio fallito:", result.error);
  }
  process.exit(0);
});
