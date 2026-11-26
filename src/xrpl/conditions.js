import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Crypto-condition PREIMAGE-SHA-256 (format utilisé par XRPL pour les escrows conditionnels).
 *   Condition   = A0258020 + SHA256(preimage) + 810120   (préimage de 32 octets)
 *   Fulfillment = A0228020 + preimage
 * Sans bibliothèque externe : uniquement le module crypto de Node.
 */
export function conditionFromPreimage(preimage) {
  if (preimage.length !== 32) throw new Error("La préimage doit faire 32 octets");
  const hash = createHash("sha256").update(preimage).digest("hex").toUpperCase();
  return {
    condition: `A0258020${hash}810120`,
    fulfillment: `A0228020${preimage.toString("hex").toUpperCase()}`,
  };
}

/** Valeur secrète aléatoire (tests, démos ponctuelles). */
export function randomCondition() {
  return conditionFromPreimage(randomBytes(32));
}

/**
 * Valeur secrète déterministe par (offre, foyer) : le vérificateur peut la recalculer
 * à partir de son secret, sans rien stocker. Elle n'est révélée que si l'objectif est atteint.
 */
export function derivePreimage(verifierSecret, offerId, foyerAddress) {
  return createHmac("sha256", verifierSecret).update(`${offerId}|${foyerAddress}`).digest();
}

export function deriveCondition(verifierSecret, offerId, foyerAddress) {
  return conditionFromPreimage(derivePreimage(verifierSecret, offerId, foyerAddress));
}
