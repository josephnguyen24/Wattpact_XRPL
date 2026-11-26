import xrpl from "xrpl";
import { SERVERS, ROLES } from "../config.js";

/** Connexion au Testnet avec serveurs de secours (le port 51233 peut être bloqué par le Wi-Fi). */
export async function connect() {
  let lastError;
  for (const url of SERVERS) {
    const client = new xrpl.Client(url);
    try {
      await client.connect();
      return client;
    } catch (e) {
      lastError = e;
      console.log(`Échec sur ${url} -> serveur suivant`);
    }
  }
  throw new Error(`Aucun serveur Testnet joignable : ${lastError?.message}`);
}

/** Charge le wallet d'un rôle depuis .env (la seed n'est jamais affichée). */
export function walletFor(role) {
  const envName = ROLES[role];
  if (!envName) throw new Error(`Rôle inconnu : ${role}`);
  const seed = process.env[envName];
  if (!seed) {
    throw new Error(`${envName} absent de .env. Lancer : npm run setup:wallets`);
  }
  return xrpl.Wallet.fromSeed(seed);
}

/** Soumet une transaction signée et vérifie le règlement (tesSUCCESS attendu). */
export async function submit(client, wallet, tx) {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob);
  const code = res.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") {
    throw new Error(`Transaction ${tx.TransactionType} refusée : ${code} (${signed.hash})`);
  }
  return { hash: signed.hash, result: res.result };
}

/** Heure de validation du dernier ledger, en secondes Ripple (pour comparer à CancelAfter). */
export async function ledgerCloseRippleTime(client) {
  const res = await client.request({ command: "ledger", ledger_index: "validated" });
  return res.result.ledger.close_time;
}
