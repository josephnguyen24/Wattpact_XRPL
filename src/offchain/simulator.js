/**
 * Simulateur de compteurs (hors chaîne). Données fictives, déterministes (graine fixe) :
 * deux exécutions donnent les mêmes relevés, donc une démo reproductible.
 */

// PRNG déterministe (mulberry32)
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Historique du créneau de pointe (kWh sur 18h-20h) des `days` derniers jours avant `eventDate`.
 * Chaque entrée : { date, weekday (0=dimanche), kwh }.
 */
export function generateHistory(foyerId, { days = 10, eventDate = "2026-12-03", seed = 42 } = {}) {
  const rand = prng(hashString(`${foyerId}:${seed}`));
  const base = 2.4 + rand() * 1.6; // consommation de base du foyer sur le créneau
  const end = new Date(`${eventDate}T00:00:00Z`);
  const out = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const weekday = d.getUTCDay();
    const weekendBoost = weekday === 0 || weekday === 6 ? 1.15 : 1;
    const noise = 0.9 + rand() * 0.2;
    out.push({
      date: d.toISOString().slice(0, 10),
      weekday,
      kwh: round3(base * weekendBoost * noise),
    });
  }
  return out;
}

/** Relevé du jour de l'événement : consommation habituelle réduite de `reduction` (0.25 = -25 %). */
export function measureEvent(history, reduction, { seed = 7, foyerId = "x" } = {}) {
  const rand = prng(hashString(`${foyerId}:event:${seed}`));
  const typical = history.filter((h) => h.weekday !== 0 && h.weekday !== 6).slice(-5);
  const mean = typical.reduce((s, h) => s + h.kwh, 0) / typical.length;
  const noise = 0.98 + rand() * 0.04;
  return round3(mean * (1 - reduction) * noise);
}
