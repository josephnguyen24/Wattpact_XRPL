/**
 * Crée les 5 comptes de test (opérateur, vérificateur, 3 foyers), les alimente via le faucet
 * et écrit les seeds dans .env (ignoré par Git). Les seeds ne sont JAMAIS affichées.
 * Si .env existe déjà avec des seeds, elles sont conservées (on ne recrée rien).
 * Si le Testnet a été réinitialisé : relancer ce script, les comptes disparus sont ré-alimentés
 * avec les mêmes seeds (mêmes adresses). Faucet saturé : nouvelles tentatives automatiques.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import xrpl from "xrpl";
import { connect, fundWithRetry, accountExists } from "../xrpl/client.js";
import { ROLES, accountUrl } from "../config.js";

const ENV = new URL("../../.env", import.meta.url);
const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : example;
const has = (name) => new RegExp(`^${name}=\\S+`, "m").test(env);
const set = (name, value) => {
  env = new RegExp(`^${name}=.*$`, "m").test(env)
    ? env.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`)
    : env + `\n${name}=${value}\n`;
};

const client = await connect();
console.log("Connecté à", client.url);

for (const [role, envName] of Object.entries(ROLES)) {
  if (has(envName)) {
    // Protocole de reprise : si le Testnet a été réinitialisé, le compte n'existe plus.
    // On garde la même seed (donc la même adresse) et on le ré-alimente via le faucet.
    const seed = env.match(new RegExp(`^${envName}=(\\S+)`, "m"))[1];
    const existing = xrpl.Wallet.fromSeed(seed);
    if (await accountExists(client, existing.address)) {
      console.log(`${role.padEnd(9)} ${existing.address}  déjà configuré, conservé`);
    } else {
      const { balance } = await fundWithRetry(client, existing);
      console.log(`${role.padEnd(9)} ${existing.address}  ré-alimenté après réinitialisation (${balance} XRP)`);
    }
    continue;
  }
  const { wallet, balance } = await fundWithRetry(client);
  set(envName, wallet.seed);
  writeFileSync(ENV, env); // écriture à chaque compte : rien n'est perdu si le faucet sature
  console.log(`${role.padEnd(9)} ${wallet.address}  (${balance} XRP)  ${accountUrl(wallet.address)}`);
}

if (!has("VERIFIER_SECRET")) set("VERIFIER_SECRET", randomBytes(32).toString("hex"));
writeFileSync(ENV, env);
await client.disconnect();
console.log("\n.env écrit (non versionné). Ne jamais partager les seeds.");
