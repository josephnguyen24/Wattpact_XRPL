import "dotenv/config";

export const SERVERS = (
  process.env.XRPL_SERVERS ||
  "wss://s.altnet.rippletest.net:51233,wss://testnet.xrpl-labs.com,wss://testnet.honeycluster.io"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const CANCEL_AFTER_SECONDS = Number(process.env.CANCEL_AFTER_SECONDS || 180);

export const EXPLORER = "https://testnet.xrpl.org";
export const txUrl = (hash) => `${EXPLORER}/transactions/${hash}`;
export const accountUrl = (addr) => `${EXPLORER}/accounts/${addr}`;

// Rôles -> variable d'environnement contenant la seed de test
export const ROLES = {
  operator: "SEED_OPERATOR",
  verifier: "SEED_VERIFIER",
  foyer1: "SEED_FOYER1",
  foyer2: "SEED_FOYER2",
  foyer3: "SEED_FOYER3",
};

export const FOYERS = ["foyer1", "foyer2", "foyer3"];

// Paramètres métier de l'offre de démonstration
export const OFFER_DEFAULTS = {
  slot: "jeudi 18h-20h",
  targetReduction: 0.2, // -20 %
  primeXrp: "5",
};
