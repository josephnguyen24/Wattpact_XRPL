import xrpl from "xrpl";
import { SERVERS, ROLES } from "../config.js";

/** Connexion au Testnet avec serveurs de secours (le port 51233 peut être bloqué par le Wi-Fi). */
export async function connect() {
  let lastError;
  for (const url of SERVERS) {
    // Délai court : si le port 51233 est filtré, on bascule vite sur un serveur port 443
    const client = new xrpl.Client(url, { connectionTimeout: 8000 });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Plusieurs transactions d'un même compte en une fois : on fixe les Sequence nous-mêmes,
 * on soumet tout, puis on attend les validations en parallèle (~1 ledger au lieu de n).
 */
export async function submitBatch(client, wallet, txs) {
  if (!txs.length) return [];
  const info = await client.request({ command: "account_info", account: wallet.address, ledger_index: "current" });
  const first = info.result.account_data.Sequence;
  const prepared = await Promise.all(txs.map((tx, i) => client.autofill({ ...tx, Sequence: first + i })));
  const signed = prepared.map((tx) => ({ tx, ...wallet.sign(tx) }));
  return Promise.all(
    signed.map(async (s, i) => {
      await sleep(i * 60); // garde l'ordre d'arrivée des Sequence
      const res = await client.submitAndWait(s.tx_blob);
      const code = res.result.meta?.TransactionResult;
      if (code !== "tesSUCCESS") throw new Error(`${s.tx.TransactionType} refusée : ${code} (${s.hash})`);
      return { hash: s.hash, result: res.result, sequence: s.tx.Sequence };
    }),
  );
}

/**
 * Faucet avec nouvelles tentatives (toute la promo l'appelle en même temps).
 * Sans `wallet` : crée un compte. Avec `wallet` : ré-alimente ce compte (Testnet réinitialisé).
 */
export async function fundWithRetry(client, wallet, { tries = 4, delayMs = 4000 } = {}) {
  let lastError;
  for (let i = 1; i <= tries; i++) {
    try {
      return await client.fundWallet(wallet);
    } catch (e) {
      lastError = e;
      if (i < tries) {
        console.log(`Faucet indisponible (essai ${i}/${tries}), nouvel essai dans ${delayMs / 1000} s...`);
        await sleep(delayMs);
      }
    }
  }
  throw new Error(`Faucet indisponible après ${tries} essais : ${lastError?.message}`);
}

/** Vrai si le compte existe sur le ledger validé (faux après une réinitialisation du Testnet). */
export async function accountExists(client, address) {
  try {
    await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return true;
  } catch (e) {
    if (e?.data?.error === "actNotFound") return false;
    throw e;
  }
}

/**
 * Soumet une transaction qui DOIT être refusée et renvoie son code de résultat.
 * Sert aux démonstrations « personne ne peut tricher » (mauvaise Fulfillment, annulation trop tôt...).
 */
export async function submitExpectingFailure(client, wallet, tx) {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob);
  const code = res.result.meta?.TransactionResult;
  if (code === "tesSUCCESS") {
    throw new Error(`ALERTE : ${tx.TransactionType} aurait dû être refusée (${signed.hash})`);
  }
  return { hash: signed.hash, code };
}

/** Heure de validation du dernier ledger, en secondes Ripple (pour comparer à CancelAfter). */
export async function ledgerCloseRippleTime(client) {
  const res = await client.request({ command: "ledger", ledger_index: "validated" });
  return res.result.ledger.close_time;
}
