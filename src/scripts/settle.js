/**
 * Règle les escrows restants de la dernière démo :
 *  - objectif manqué -> EscrowCancel (prime rendue à l'opérateur), possible après CancelAfter
 * Usage : npm run settle [-- --wait]
 */
import { fileURLToPath } from "node:url";
import xrpl from "xrpl";
import { connect, walletFor } from "../xrpl/client.js";
import { refundPrime, canCancel } from "../xrpl/market.js";
import { loadState, saveState } from "../offchain/state.js";
import { txUrl } from "../config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function settle(client, { wait = false } = {}) {
  const state = loadState();
  if (!state) throw new Error("Aucun état trouvé (data/state.json). Lancer d'abord : npm run demo");
  const verifier = walletFor("verifier");

  for (const [name, f] of Object.entries(state.foyers)) {
    if (f.verdict !== "missed" || f.status !== "locked") continue;
    const e = f.escrow;
    while (!(await canCancel(client, e.cancelAfter))) {
      const iso = new Date(xrpl.rippleTimeToUnixTime(e.cancelAfter)).toLocaleTimeString("fr-FR");
      if (!wait) {
        console.log(`${name} : CancelAfter pas encore atteint (${iso}). Réessayer plus tard.`);
        break;
      }
      console.log(`${name} : attente de CancelAfter (${iso})...`);
      await sleep(10_000);
    }
    if (!(await canCancel(client, e.cancelAfter))) continue;
    const res = await refundPrime(client, verifier, state.operator, e.sequence);
    f.status = "refunded";
    f.settleHash = res.hash;
    console.log(`[5 Remboursement] ${name} : prime rendue à l'opérateur\n      ${txUrl(res.hash)}`);
    saveState(state);
  }
}

// Exécution directe : node src/scripts/settle.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const client = await connect();
  await settle(client, { wait: process.argv.includes("--wait") });
  await client.disconnect();
}
