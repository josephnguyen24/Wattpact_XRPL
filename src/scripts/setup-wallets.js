/**
 * Crée les 5 comptes de test (opérateur, vérificateur, 3 foyers), les alimente via le faucet
 * et écrit les seeds dans .env (ignoré par Git). Les seeds ne sont JAMAIS affichées.
 * Si .env existe déjà avec des seeds, elles sont conservées (on ne recrée rien).
 * Si le Testnet a été réinitialisé : supprimer .env puis relancer ce script.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { connect } from "../xrpl/client.js";
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
    console.log(`${role.padEnd(9)} déjà configuré, conservé`);
    continue;
  }
  const { wallet, balance } = await client.fundWallet();
  set(envName, wallet.seed);
  writeFileSync(ENV, env); // écriture à chaque compte : rien n'est perdu si le faucet sature
  console.log(`${role.padEnd(9)} ${wallet.address}  (${balance} XRP)  ${accountUrl(wallet.address)}`);
}

if (!has("VERIFIER_SECRET")) set("VERIFIER_SECRET", randomBytes(32).toString("hex"));
writeFileSync(ENV, env);
await client.disconnect();
console.log("\n.env écrit (non versionné). Ne jamais partager les seeds.");
