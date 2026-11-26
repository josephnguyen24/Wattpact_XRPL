/**
 * « Personne ne peut tricher » : tentatives de fraude soumises au Testnet, toutes refusées par le ledger.
 *   1. Le foyer tente de se payer avec une fausse valeur secrète      -> tecCRYPTOCONDITION_ERROR
 *   2. Le foyer tente de se payer sans valeur secrète                  -> tecCRYPTOCONDITION_ERROR
 *   3. L'opérateur tente de reprendre la prime avant CancelAfter       -> tecNO_PERMISSION
 *   4. Le vérificateur libère avec la bonne valeur : la prime va au FOYER (destination figée),
 *      le vérificateur ne touche rien.
 * Usage : npm run anti-triche
 */
import { randomBytes } from "node:crypto";
import { connect, walletFor, submitExpectingFailure } from "../xrpl/client.js";
import { conditionFromPreimage, deriveCondition } from "../xrpl/conditions.js";
import { lockPrime, releasePrime } from "../xrpl/market.js";
import { txUrl } from "../config.js";

const secret = process.env.VERIFIER_SECRET;
if (!secret) throw new Error("VERIFIER_SECRET absent de .env. Lancer : npm run setup:wallets");

const client = await connect();
console.log("Connecté à", client.url, "\n");

const operator = walletFor("operator");
const verifier = walletFor("verifier");
const foyer = walletFor("foyer1");
const PRIME = "1";

const offerId = `anti-triche-${randomBytes(4).toString("hex")}`;
const { condition, fulfillment } = deriveCondition(secret, offerId, foyer.address);
const lock = await lockPrime(client, operator, foyer.address, PRIME, condition);
console.log(`[Escrow] ${PRIME} XRP verrouillés pour foyer1\n      ${txUrl(lock.hash)}\n`);

const escrowRef = { Owner: operator.address, OfferSequence: lock.sequence };
let ok = true;
async function attempt(label, wallet, tx, expected) {
  const { hash, code } = await submitExpectingFailure(client, wallet, tx);
  const pass = code === expected;
  ok &&= pass;
  console.log(`[${pass ? "REFUSÉ" : "INATTENDU"}] ${label} -> ${code}${pass ? "" : ` (attendu ${expected})`}\n      ${txUrl(hash)}`);
}

const fausse = conditionFromPreimage(randomBytes(32)).fulfillment;
await attempt("Foyer : fausse valeur secrète", foyer,
  { TransactionType: "EscrowFinish", Account: foyer.address, ...escrowRef, Condition: condition, Fulfillment: fausse },
  "tecCRYPTOCONDITION_ERROR");

await attempt("Foyer : libération sans valeur secrète", foyer,
  { TransactionType: "EscrowFinish", Account: foyer.address, ...escrowRef },
  "tecCRYPTOCONDITION_ERROR");

await attempt("Opérateur : reprise de la prime avant CancelAfter", operator,
  { TransactionType: "EscrowCancel", Account: operator.address, ...escrowRef },
  "tecNO_PERMISSION");

const avantFoyer = Number(await client.getXrpBalance(foyer.address));
const avantVerif = Number(await client.getXrpBalance(verifier.address));
const rel = await releasePrime(client, verifier, operator.address, lock.sequence, condition, fulfillment);
const gainFoyer = Number(await client.getXrpBalance(foyer.address)) - avantFoyer;
const gainVerif = Number(await client.getXrpBalance(verifier.address)) - avantVerif;
const destOk = Math.abs(gainFoyer - Number(PRIME)) < 1e-6 && gainVerif <= 0;
ok &&= destOk;
console.log(
  `\n[${destOk ? "OK" : "INATTENDU"}] Vérificateur : bonne valeur secrète -> prime versée au foyer ` +
    `(foyer +${gainFoyer.toFixed(6)} XRP, vérificateur ${gainVerif.toFixed(6)} XRP de frais)\n      ${txUrl(rel.hash)}`,
);

await client.disconnect();
console.log(ok ? "\nToutes les tentatives de triche ont été refusées par le ledger." : "\nATTENTION : comportement inattendu, voir ci-dessus.");
process.exitCode = ok ? 0 : 1;
