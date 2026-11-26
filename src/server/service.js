// Logique métier de l'API : une fonction par action d'un acteur.
// Les transactions d'un même compte partent groupées (submitBatch), celles de comptes
// différents partent en parallèle.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import xrpl from "xrpl";
import { connect, walletFor, submitBatch } from "../xrpl/client.js";
import { deriveCondition } from "../xrpl/conditions.js";
import { publishOffer, acceptOffer, escrowCreateTx, measureTx } from "../xrpl/market.js";
import { generateHistory, measureEvent } from "../offchain/simulator.js";
import { computeBaseline, evaluate, releveHash } from "../offchain/verifier.js";
import { FOYERS, OFFER_DEFAULTS, EXPLORER, SERVERS } from "../config.js";

// État local : hashs, séquences, statuts. Pas de seed, pas de fulfillment.
const STORE = fileURLToPath(new URL("../../data/app-state.json", import.meta.url));
const load = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { offers: [] });
const save = () => {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(db, null, 2));
};
let db = load();

let client;
async function getClient() {
  if (!client || !client.isConnected()) client = await connect();
  return client;
}

// Une action à la fois (sinon deux clics rapides se marchent dessus sur les Sequence)
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function secret() {
  if (!process.env.VERIFIER_SECRET) throw new HttpError(500, "VERIFIER_SECRET manquant, lancer npm run setup:wallets");
  return process.env.VERIFIER_SECRET;
}

function findOffer(hash) {
  const o = db.offers.find((x) => x.hash === hash);
  if (!o) throw new HttpError(404, "Offre inconnue");
  return o;
}

const foyersWith = (o, status) => FOYERS.filter((f) => o.foyers[f].status === status);

// ---------- lecture ----------

export async function accounts() {
  const c = await getClient();
  const out = {};
  await Promise.all(
    ["operator", "verifier", ...FOYERS].map(async (role) => {
      const address = walletFor(role).address;
      const balance = await c.getXrpBalance(address).catch(() => null);
      out[role] = { address, balance };
    }),
  );
  return { server: c.url, servers: SERVERS, explorer: EXPLORER, defaults: OFFER_DEFAULTS, accounts: out };
}

export async function listOffers() {
  const c = await getClient();
  const r = await c.request({ command: "ledger", ledger_index: "validated" });
  const now = r.result.ledger.close_time;
  return db.offers
    .slice()
    .reverse()
    .map((o) => ({
      ...o,
      foyers: Object.fromEntries(
        Object.entries(o.foyers).map(([f, v]) => [f, { ...v, cancellable: v.status === "locked" && now > v.escrow?.cancelAfter }]),
      ),
    }));
}

// ---------- opérateur ----------

export const createOffer = (input = {}) =>
  serial(async () => {
    const offer = {
      slot: String(input.slot || OFFER_DEFAULTS.slot).slice(0, 60),
      targetReduction: Number(input.targetReduction ?? OFFER_DEFAULTS.targetReduction),
      primeXrp: String(input.primeXrp ?? OFFER_DEFAULTS.primeXrp),
    };
    if (!(offer.targetReduction > 0 && offer.targetReduction < 1)) throw new HttpError(400, "Objectif entre 1 et 99 %");
    if (!(Number(offer.primeXrp) > 0 && Number(offer.primeXrp) <= 20)) throw new HttpError(400, "Prime entre 0 et 20 XRP");

    const c = await getClient();
    const operator = walletFor("operator");
    const verifier = walletFor("verifier");
    const tx = await publishOffer(c, operator, verifier.address, offer);
    const record = {
      hash: tx.hash,
      ...offer,
      createdAt: new Date().toISOString(),
      operator: operator.address,
      verifier: verifier.address,
      status: "open",
      foyers: Object.fromEntries(FOYERS.map((f) => [f, { address: walletFor(f).address, status: "invited" }])),
    };
    db.offers.push(record);
    save();
    return record;
  });

/** L'opérateur bloque en une fois la prime de chaque foyer qui a accepté. */
export const lockAccepted = (hash) =>
  serial(async () => {
    const o = findOffer(hash);
    const todo = foyersWith(o, "accepted");
    if (!todo.length) throw new HttpError(409, "Aucune acceptation en attente");

    const c = await getClient();
    const operator = walletFor("operator");
    const built = todo.map((f) => {
      const { condition } = deriveCondition(secret(), o.hash, o.foyers[f].address);
      return { f, condition, ...escrowCreateTx(operator.address, o.foyers[f].address, o.primeXrp, condition) };
    });
    const results = await submitBatch(c, operator, built.map((b) => b.tx));
    built.forEach((b, i) => {
      o.foyers[b.f].escrow = { sequence: results[i].sequence, condition: b.condition, cancelAfter: b.cancelAfter, createHash: results[i].hash };
      o.foyers[b.f].status = "locked";
    });
    save();
    return o;
  });

/** Primes manquées rendues à l'opérateur, une fois CancelAfter passé. */
export const settleOffer = (hash) =>
  serial(async () => {
    const o = findOffer(hash);
    const c = await getClient();
    const r = await c.request({ command: "ledger", ledger_index: "validated" });
    const now = r.result.ledger.close_time;
    const missed = foyersWith(o, "locked").filter((f) => o.foyers[f].verdict === "missed");
    const ready = missed.filter((f) => now > o.foyers[f].escrow.cancelAfter);
    if (!ready.length) throw new HttpError(409, "CancelAfter pas encore passé sur le ledger, réessayer dans quelques secondes");

    const operator = walletFor("operator");
    const results = await submitBatch(
      c,
      operator,
      ready.map((f) => ({ TransactionType: "EscrowCancel", Account: operator.address, Owner: operator.address, OfferSequence: o.foyers[f].escrow.sequence })),
    );
    ready.forEach((f, i) => Object.assign(o.foyers[f], { status: "refunded", settleHash: results[i].hash }));
    if (!foyersWith(o, "locked").length) o.status = "closed";
    save();
    return o;
  });

// ---------- foyers ----------

/** Les foyers signent eux-mêmes ; plusieurs foyers = comptes différents, donc en parallèle. */
export const accept = (hash, list) =>
  serial(async () => {
    const o = findOffer(hash);
    if (o.status !== "open") throw new HttpError(409, "Offre fermée");
    const todo = list.filter((f) => FOYERS.includes(f) && o.foyers[f].status === "invited");
    if (!todo.length) throw new HttpError(409, "Déjà accepté");

    const c = await getClient();
    const res = await Promise.all(todo.map((f) => acceptOffer(c, walletFor(f), o.operator, o.hash)));
    todo.forEach((f, i) => Object.assign(o.foyers[f], { status: "accepted", acceptHash: res[i].hash }));
    save();
    return o;
  });

// ---------- vérificateur ----------

/**
 * Mesure (simulée), publication des empreintes AVANT le verdict, puis libération groupée
 * des primes gagnées. reductions = { foyer1: 0.25, ... }
 */
export const measure = (hash, reductions = {}) =>
  serial(async () => {
    const o = findOffer(hash);
    if (o.status !== "open") throw new HttpError(409, "Mesure déjà faite");
    const locked = foyersWith(o, "locked");
    if (!locked.length) throw new HttpError(409, "Aucune prime verrouillée");
    if (foyersWith(o, "accepted").length) throw new HttpError(409, "Des acceptations attendent encore leur escrow");

    const c = await getClient();
    const operator = walletFor("operator");
    const verifier = walletFor("verifier");
    const measures = locked.map((f) => {
      const r = Math.min(Math.max(Number(reductions[f] ?? 0), 0), 0.9);
      const history = generateHistory(f);
      const { baselineKwh } = computeBaseline(history);
      const measuredKwh = measureEvent(history, r, { foyerId: f });
      const v = evaluate({ baselineKwh, measuredKwh, targetReduction: o.targetReduction });
      const rh = releveHash({ offerHash: o.hash, foyer: o.foyers[f].address, slot: o.slot, measuredKwh });
      Object.assign(o.foyers[f], {
        baselineKwh, measuredKwh, reduction: v.reduction, releveHash: rh, verdict: v.reached ? "reached" : "missed",
      });
      return { foyer: o.foyers[f].address, releveHash: rh };
    });
    // Un seul envoi : relevés d'abord (Sequence n), libérations ensuite (n+1...).
    // Le ledger applique les Sequence dans l'ordre : les empreintes ne peuvent pas arriver après le verdict.
    const winners = locked.filter((f) => o.foyers[f].verdict === "reached");
    const [m, ...results] = await submitBatch(c, verifier, [
      measureTx(verifier.address, operator.address, { offerHash: o.hash, measures }),
      ...winners.map((f) => {
        const e = o.foyers[f].escrow;
        return {
          TransactionType: "EscrowFinish",
          Account: verifier.address,
          Owner: operator.address,
          OfferSequence: e.sequence,
          Condition: e.condition,
          Fulfillment: deriveCondition(secret(), o.hash, o.foyers[f].address).fulfillment,
        };
      }),
    ]);
    o.measureHash = m.hash;
    o.status = "measured";
    winners.forEach((f, i) => Object.assign(o.foyers[f], { status: "released", settleHash: results[i].hash }));
    if (!foyersWith(o, "locked").length) o.status = "closed";
    save();
    return o;
  });

export function resetLocal() {
  db = { offers: [] };
  save();
}

export { xrpl };
