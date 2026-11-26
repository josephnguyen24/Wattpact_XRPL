import { createHash } from "node:crypto";

/**
 * Référence (baseline) : moyenne du même créneau sur les 5 derniers jours comparables
 * (jours de semaine). Moyenne sur plusieurs jours = limite la fraude à la référence.
 */
export function computeBaseline(history, { nDays = 5 } = {}) {
  const comparable = history.filter((h) => h.weekday !== 0 && h.weekday !== 6).slice(-nDays);
  if (comparable.length < nDays) {
    throw new Error(`Historique insuffisant : ${comparable.length} jours comparables sur ${nDays}`);
  }
  const mean = comparable.reduce((s, h) => s + h.kwh, 0) / comparable.length;
  return { baselineKwh: Math.round(mean * 1000) / 1000, days: comparable.map((h) => h.date) };
}

/** Objectif atteint si consommation mesurée <= référence x (1 - réduction cible). */
export function evaluate({ baselineKwh, measuredKwh, targetReduction }) {
  const threshold = baselineKwh * (1 - targetReduction);
  const reached = measuredKwh <= threshold;
  return {
    reached,
    thresholdKwh: Math.round(threshold * 1000) / 1000,
    reduction: Math.round((1 - measuredKwh / baselineKwh) * 1000) / 1000,
  };
}

/**
 * Empreinte du relevé : SHA-256 d'un JSON canonique (clés triées).
 * Seule cette empreinte va on-chain, jamais la consommation (aucune donnée personnelle).
 */
export function releveHash(releve) {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(releve).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}
