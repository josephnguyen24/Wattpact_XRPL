// Logique métier de l'API : une fonction par action d'un acteur.
// Les transactions d'un même compte partent groupées (submitBatch), celles de comptes
// différents partent en parallèle.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import xrpl from "xrpl";
import { connect, walletFor, submitBatch, firstError, fundWithRetry } from "../xrpl/client.js";
import { deriveCondition } from "../xrpl/conditions.js";
import { publishOffer, acceptOffer, escrowCreateTx, measureTx } from "../xrpl/market.js";
import { generateHistory, measureEvent } from "../offchain/simulator.js";
import { computeBaseline, evaluate, releveHash } from "../offchain/verifier.js";
import { FOYERS, OFFER_DEFAULTS, EXPLORER, SERVERS, CANCEL_AFTER_SECONDS } from "../config.js";

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

async function ledgerTime(c) {
  const r = await c.request({ command: "ledger", ledger_index: "validated" });
  return r.result.ledger.close_time;
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
  return { server: c.url, servers: SERVERS, explorer: EXPLORER, defaults: OFFER_DEFAULTS, cancelAfterSeconds: CANCEL_AFTER_SECONDS, accounts: out };
}

/** Historique simulé du créneau de pointe (10 jours) et référence, par foyer : données hors chaîne. */
export function histories() {
  return Object.fromEntries(FOYERS.map((f) => {
    const history = generateHistory(f);
    const { baselineKwh, days } = computeBaseline(history);
    return [f, { history, baselineKwh, baselineDays: days }];
  }));
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
    if (o.status !== "open") throw new HttpError(409, "Mesure déjà faite : une prime bloquée maintenant ne pourrait plus être versée");
    const todo = foyersWith(o, "accepted");
    if (!todo.length) throw new HttpError(409, "Aucune acceptation en attente");

    const c = await getClient();
    const operator = walletFor("operator");

    // Solde disponible = solde - réserve (base + 1 incrément par objet possédé, dont chaque escrow créé)
    const need = todo.length * Number(o.primeXrp);
    const { available } = await spendable(c, operator.address, todo.length);
    if (available < need + 0.01) {
      throw new HttpError(409, `Solde opérateur insuffisant : ${available.toFixed(2)} XRP disponibles, ${need} XRP nécessaires. Récupérer les primes expirées ou recharger au faucet.`);
    }

    const built = todo.map((f) => {
      const { condition } = deriveCondition(secret(), o.hash, o.foyers[f].address);
      return { f, condition, ...escrowCreateTx(operator.address, o.foyers[f].address, o.primeXrp, condition) };
    });
    const results = await submitBatch(c, operator, built.map((b) => b.tx));
    // on enregistre chaque escrow créé, même si un autre de l'envoi a échoué
    built.forEach((b, i) => {
      if (results[i].error) return;
      o.foyers[b.f].escrow = { sequence: results[i].sequence, condition: b.condition, cancelAfter: b.cancelAfter, createHash: results[i].hash };
      o.foyers[b.f].status = "locked";
    });
    save();
    firstError(results);
    return o;
  });

/** XRP réellement dépensables par un compte, en tenant compte de la réserve du ledger. */
async function spendable(c, address, newObjects = 0) {
  const [info, state] = await Promise.all([
    c.request({ command: "account_info", account: address, ledger_index: "validated" }),
    c.request({ command: "server_state" }),
  ]);
  const v = state.result.state.validated_ledger;
  const base = Number(v.reserve_base) / 1e6;
  const inc = Number(v.reserve_inc) / 1e6;
  const balance = Number(info.result.account_data.Balance) / 1e6;
  const owned = info.result.account_data.OwnerCount + newObjects;
  return { balance, available: balance - base - inc * owned };
}

/**
 * Rembourse à l'opérateur TOUS ses escrows expirés, lus directement sur le ledger
 * (y compris ceux que l'état local ne connaît pas). Met à jour les offres correspondantes.
 */
export const recoverExpired = () =>
  serial(async () => {
    const c = await getClient();
    const operator = walletFor("operator");
    const now = await ledgerTime(c);
    const objs = (await c.request({ command: "account_objects", account: operator.address, type: "escrow", ledger_index: "validated" })).result.account_objects;
    const expired = objs.filter((e) => e.CancelAfter && now > e.CancelAfter);
    if (!expired.length) throw new HttpError(409, "Aucune prime expirée à récupérer");

    // la Sequence de création se retrouve via la transaction qui a créé l'objet
    const seqs = await Promise.all(expired.map(async (e) => {
      const tx = await c.request({ command: "tx", transaction: e.PreviousTxnID });
      return (tx.result.tx_json ?? tx.result).Sequence;
    }));
    const results = await submitBatch(c, operator, seqs.map((seq) => ({
      TransactionType: "EscrowCancel", Account: operator.address, Owner: operator.address, OfferSequence: seq,
    })));
    let recovered = 0;
    seqs.forEach((seq, i) => {
      if (results[i].error) return;
      recovered += Number(xrpl.dropsToXrp(expired[i].Amount));
      for (const o of db.offers) {
        for (const f of FOYERS) {
          if (o.foyers[f].escrow?.sequence === seq && o.foyers[f].status === "locked") {
            Object.assign(o.foyers[f], { status: "refunded", settleHash: results[i].hash });
          }
        }
        if (o.status !== "closed" && FOYERS.every((f) => !["locked", "accepted"].includes(o.foyers[f].status)) && FOYERS.some((f) => o.foyers[f].status === "refunded")) o.status = "closed";
      }
    });
    save();
    firstError(results);
    return { count: results.filter((r) => !r.error).length, recovered };
  });

/** Testnet uniquement : ré-alimente l'opérateur via le faucet. */
export const topUpOperator = () =>
  serial(async () => {
    const c = await getClient();
    const { balance } = await fundWithRetry(c, walletFor("operator"));
    return { balance };
  });

/**
 * Après CancelAfter, toute prime encore bloquée revient à l'opérateur : objectif manqué,
 * mais aussi vérificateur qui n'a jamais mesuré (le ledger interdit alors EscrowFinish).
 */
export const settleOffer = (hash) =>
  serial(async () => {
    const o = findOffer(hash);
    const c = await getClient();
    const now = await ledgerTime(c);
    const ready = foyersWith(o, "locked").filter((f) => now > o.foyers[f].escrow.cancelAfter);
    if (!ready.length) throw new HttpError(409, "Échéance pas encore passée sur le ledger, réessayer dans quelques secondes");

    const operator = walletFor("operator");
    const results = await submitBatch(
      c,
      operator,
      ready.map((f) => ({ TransactionType: "EscrowCancel", Account: operator.address, Owner: operator.address, OfferSequence: o.foyers[f].escrow.sequence })),
    );
    ready.forEach((f, i) => {
      if (!results[i].error) Object.assign(o.foyers[f], { status: "refunded", settleHash: results[i].hash });
    });
    if (!foyersWith(o, "locked").length && !foyersWith(o, "accepted").length) o.status = "closed";
    save();
    firstError(results);
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
    // Un foyer qui a accepté sans que l'opérateur bloque sa prime ne bloque pas les autres :
    // il reste « accepté » (acceptation signée on-chain, aucun escrow : défaut de l'opérateur, visible).

    const c = await getClient();
    // Après CancelAfter, XRPL refuse EscrowFinish (tecNO_PERMISSION) : on vérifie avant d'envoyer quoi que ce soit.
    // Marge de 15 s : le temps que les transactions soient validées.
    const deadline = Math.min(...locked.map((f) => o.foyers[f].escrow.cancelAfter));
    if ((await ledgerTime(c)) + 15 > deadline) {
      throw new HttpError(409, "Trop tard : l'échéance des escrows est passée, la prime ne peut plus être versée. L'opérateur peut la récupérer.");
    }

    const operator = walletFor("operator");
    const verifier = walletFor("verifier");
    // Calculé à part : rien n'est écrit dans l'état tant que le ledger n'a pas validé
    const results = Object.fromEntries(locked.map((f) => {
      const r = Math.min(Math.max(Number(reductions[f] ?? 0), 0), 0.9);
      const history = generateHistory(f);
      const { baselineKwh } = computeBaseline(history);
      const measuredKwh = measureEvent(history, r, { foyerId: f });
      const v = evaluate({ baselineKwh, measuredKwh, targetReduction: o.targetReduction });
      const rh = releveHash({ offerHash: o.hash, foyer: o.foyers[f].address, slot: o.slot, measuredKwh });
      return [f, { baselineKwh, measuredKwh, reduction: v.reduction, releveHash: rh, verdict: v.reached ? "reached" : "missed" }];
    }));
    const measures = locked.map((f) => ({ foyer: o.foyers[f].address, releveHash: results[f].releveHash }));
    // Un seul envoi : relevés d'abord (Sequence n), libérations ensuite (n+1...).
    // Le ledger applique les Sequence dans l'ordre : les empreintes ne peuvent pas arriver après le verdict.
    const winners = locked.filter((f) => results[f].verdict === "reached");
    const [m, ...released] = await submitBatch(c, verifier, [
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
    if (m.error) throw m.error; // relevés non publiés : rien n'est enregistré
    o.measureHash = m.hash;
    o.status = "measured";
    locked.forEach((f) => Object.assign(o.foyers[f], results[f]));
    winners.forEach((f, i) => {
      if (!released[i].error) Object.assign(o.foyers[f], { status: "released", settleHash: released[i].hash });
    });
    if (!foyersWith(o, "locked").length) o.status = "closed";
    save();
    firstError(released);
    return o;
  });

export function resetLocal() {
  db = { offers: [] };
  save();
}

export { xrpl };
