// src/services/auth.service.js
const bcrypt = require("bcryptjs");
const prisma = require("../lib/prisma");

const SALT_ROUNDS = 12;

/**
 * Verifica email + password e restituisce l'utente se valido.
 * Lancia un errore con messaggio user-friendly in caso di fallimento.
 */
async function authenticate(email, password) {
  if (!email || !password) {
    throw new Error("Email e password sono obbligatori.");
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
  });

  if (!user) {
    throw new Error("Credenziali non valide.");
  }

  if (!user.isActive) {
    throw new Error("Account disabilitato. Contatta un amministratore.");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Error("Credenziali non valide.");
  }

  return user;
}

/**
 * Aggiorna la password dell'utente e azzera il flag mustChangePassword.
 */
async function changePassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: hash, mustChangePassword: false },
  });
}

/**
 * Restituisce l'hash bcrypt di una password in chiaro.
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

module.exports = { authenticate, changePassword, hashPassword };
