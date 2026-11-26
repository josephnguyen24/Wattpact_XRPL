/**
 * Scénario WattPact de bout en bout sur le Testnet :
 *   offre -> acceptations -> escrows -> mesure -> libération (objectif atteint)
 * Les foyers qui ratent l'objectif restent verrouillés : `npm run settle` les rembourse
 * à l'opérateur une fois CancelAfter dépassé (ou option --wait pour attendre ici).
 *
 *   npm run demo:success | demo:fail | demo:mixed
 */
import { connect, walletFor } from "../xrpl/client.js";
import { deriveCondition } from "../xrpl/conditions.js";
import { publishOffer, acceptOffer, lockPrime, publishMeasureHash, releasePrime } from "../xrpl/market.js";
import { generateHistory, measureEvent } from "../offchain/simulator.js";
import { computeBaseline, evaluate, releveHash } from "../offchain/verifier.js";
import { saveState } from "../offchain/state.js";
import { settle } from "./settle.js";
import { FOYERS, OFFER_DEFAULTS, txUrl } from "../config.js";

const args = process.argv.slice(2);
const outcome = args.includes("--outcome") ? args[args.indexOf("--outcome") + 1] : "mixed";
const wait = args.includes("--wait");

// Réduction réelle simulée par foyer selon le scénario
const REDUCTIONS = {
  success: { foyer1: 0.25, foyer2: 0.3, foyer3: 0.22 },
  fail: { foyer1: 0.05, foyer2: 0.08, foyer3: 0.02 },
  mixed: { foyer1: 0.25, foyer2: 0.3, foyer3: 0.05 },
}[outcome];
if (!REDUCTIONS) throw new Error(`--outcome inconnu : ${outcome} (success | fail | mixed)`);

const secret = process.env.VERIFIER_SECRET;
if (!secret) throw new Error("VERIFIER_SECRET absent de .env. Lancer : npm run setup:wallets");

const log = (step, msg, hash) => console.log(`[${step}] ${msg}${hash ? `\n      ${txUrl(hash)}` : ""}`);

const client = await connect();
console.log("Connecté à", client.url, `| scénario : ${outcome}\n`);

const operator = walletFor("operator");
const verifier = walletFor("verifier");
const foyers = Object.fromEntries(FOYERS.map((f) => [f, walletFor(f)]));

// 1. Offre
const offer = {
  slot: OFFER_DEFAULTS.slot,
  targetReduction: OFFER_DEFAULTS.targetReduction,
  primeXrp: OFFER_DEFAULTS.primeXrp,
};
const offerTx = await publishOffer(client, operator, verifier.address, offer);
log("1 Offre", `${offer.slot}, -${offer.targetReduction * 100} %, prime ${offer.primeXrp} XRP`, offerTx.hash);

const state = {
  outcome,
  createdAt: new Date().toISOString(),
  operator: operator.address,
  verifier: verifier.address,
  offer: { hash: offerTx.hash, ...offer },
  foyers: {},
};

// 2. Acceptations + 3. Verrouillage
for (const f of FOYERS) {
  const acc = await acceptOffer(client, foyers[f], operator.address, offerTx.hash);
  log("2 Acceptation", `${f} (${foyers[f].address})`, acc.hash);

  const { condition, fulfillment } = deriveCondition(secret, offerTx.hash, foyers[f].address);
  const lock = await lockPrime(client, operator, foyers[f].address, offer.primeXrp, condition);
  log("3 Verrouillage", `${f} : ${offer.primeXrp} XRP bloqués`, lock.hash);

  // La fulfillment N'EST PAS écrite dans l'état : le vérificateur la recalcule depuis son secret.
  state.foyers[f] = {
    address: foyers[f].address,
    acceptHash: acc.hash,
    escrow: { sequence: lock.sequence, condition, cancelAfter: lock.cancelAfter, createHash: lock.hash },
    status: "locked",
  };
}

// 4. Mesure : référence, relevé, verdict, puis empreintes publiées on-chain AVANT le verdict
const verdicts = {};
const measures = [];
for (const f of FOYERS) {
  const history = generateHistory(f);
  const baseline = computeBaseline(history);
  const measuredKwh = measureEvent(history, REDUCTIONS[f], { foyerId: f });
  const verdict = evaluate({ baselineKwh: baseline.baselineKwh, measuredKwh, targetReduction: offer.targetReduction });
  const hash = releveHash({ offerHash: offerTx.hash, foyer: foyers[f].address, slot: offer.slot, measuredKwh });
  verdicts[f] = { ...verdict, baselineKwh: baseline.baselineKwh, measuredKwh };
  measures.push({ foyer: foyers[f].address, releveHash: hash });
  state.foyers[f].releveHash = hash;
  state.foyers[f].verdict = verdict.reached ? "reached" : "missed";
}
const measureTx = await publishMeasureHash(client, verifier, operator.address, { offerHash: offerTx.hash, measures });
state.measureHash = measureTx.hash;
log("4 Mesure", "empreintes des relevés publiées (aucune consommation on-chain)", measureTx.hash);
for (const f of FOYERS) {
  const v = verdicts[f];
  console.log(
    `      ${f} : référence ${v.baselineKwh} kWh, mesuré ${v.measuredKwh} kWh, ` +
      `réduction ${(v.reduction * 100).toFixed(1)} % -> ${v.reached ? "OBJECTIF ATTEINT" : "objectif manqué"}`,
  );
}
saveState(state);

// 5a. Libération immédiate pour les foyers qui ont atteint l'objectif
for (const f of FOYERS) {
  if (!verdicts[f].reached) continue;
  const { fulfillment } = deriveCondition(secret, offerTx.hash, foyers[f].address);
  const e = state.foyers[f].escrow;
  const rel = await releasePrime(client, verifier, operator.address, e.sequence, e.condition, fulfillment);
  state.foyers[f].status = "released";
  state.foyers[f].settleHash = rel.hash;
  log("5 Libération", `${f} reçoit ${offer.primeXrp} XRP`, rel.hash);
}
saveState(state);

// 5b. Remboursement des autres : après CancelAfter (immédiat avec --wait, sinon `npm run settle`)
const pending = FOYERS.filter((f) => !verdicts[f].reached);
if (pending.length) {
  if (wait) {
    await settle(client, { wait: true });
  } else {
    console.log(
      `\n${pending.length} prime(s) restent verrouillées (objectif manqué). Remboursement possible après CancelAfter :` +
        `\n  npm run settle   (ou --wait pour attendre ici)`,
    );
  }
}
await client.disconnect();
