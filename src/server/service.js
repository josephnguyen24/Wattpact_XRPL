/**
 * Service WattPact : le scénario de demo.js découpé en actions unitaires, pilotées par l'API.
 * Une seule connexion XRPL partagée ; les transactions sont sérialisées (pas de conflit de Sequence).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, walletFor } from "../xrpl/client.js";
import { deriveCondition } from "../xrpl/conditions.js";
import {
  publishOffer, acceptOffer, lockPrime, publishMeasureHash, releasePrime, refundPrime, canCancel,
} from "../xrpl/market.js";
import { generateHistory, measureEvent } from "../offchain/simulator.js";
import { computeBaseline, evaluate, releveHash } from "../offchain/verifier.js";
import { FOYERS, OFFER_DEFAULTS, EXPLORER, CANCEL_AFTER_SECONDS } from "../config.js";
import xrpl from "xrpl";

// ---------- Persistance (hashs, séquences d'escrow, statuts ; jamais de seed ni de Fulfillment) ----------
const STORE = fileURLToPath(new URL("../../data/app-state.json", import.meta.url));
const load = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { offers: [] });
const save = (s) => {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(s, null, 2));
};
let db = load();

// ---------- Connexion partagée + file d'attente des transactions ----------
let client;
async function getClient() {
  if (!client || !client.isConnected()) client = await connect();
  return client;
}
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

const secret = () => {
  const s = process.env.VERIFIER_SECRET;
  if (!s) throw new HttpError(500, "VERIFIER_SECRET absent de .env. Lancer : npm run setup:wallets");
  return s;
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const findOffer = (hash) => {
  const o = db.offers.find((x) => x.hash === hash);
  if (!o) throw new HttpError(404, "Offre inconnue");
  return o;
};

// ---------- Lecture ----------
export async function accounts() {
  const c = await getClient();
  const roles = ["operator", "verifier", ...FOYERS];
  const out = {};
  for (const role of roles) {
    const address = walletFor(role).address;
    let balance = null;
    try { balance = await c.getXrpBalance(address); } catch { /* compte absent : Testnet réinitialisé */ }
    out[role] = { address, balance };
  }
  return { server: c.url, explorer: EXPLORER, cancelAfterSeconds: CANCEL_AFTER_SECONDS, defaults: OFFER_DEFAULTS, accounts: out };
}

export async function listOffers() {
  const c = await getClient();
  const now = await ledgerNow(c);
  return db.offers
    .slice()
    .reverse()
    .map((o) => ({
      ...o,
      foyers: Object.fromEntries(
        Object.entries(o.foyers).map(([f, v]) => [f, { ...v, cancellable: v.status === "locked" && v.escrow && now > v.escrow.cancelAfter }]),
      ),
    }));
}

async function ledgerNow(c) {
  const r = await c.request({ command: "ledger", ledger_index: "validated" });
  return r.result.ledger.close_time;
}

// ---------- Actions ----------

/** 1. L'opérateur publie une offre (Payment + Memo). */
export const createOffer = (input = {}) => serial(async () => {
  const offer = {
    slot: String(input.slot || OFFER_DEFAULTS.slot).slice(0, 60),
    targetReduction: Number(input.targetReduction ?? OFFER_DEFAULTS.targetReduction),
    primeXrp: String(input.primeXrp ?? OFFER_DEFAULTS.primeXrp),
  };
  if (!(offer.targetReduction > 0 && offer.targetReduction < 1)) throw new HttpError(400, "Objectif entre 1 et 99 %");
  const prime = Number(offer.primeXrp);
  if (!(prime > 0 && prime <= 20)) throw new HttpError(400, "Prime entre 0 et 20 XRP");

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
  save(db);
  return record;
});

/** 2 + 3. Le foyer accepte (sa propre signature), puis l'opérateur verrouille la prime en escrow. */
export const acceptAndLock = (hash, foyer) => serial(async () => {
  const o = findOffer(hash);
  if (!FOYERS.includes(foyer)) throw new HttpError(400, "Foyer inconnu");
  if (o.status !== "open") throw new HttpError(409, "Offre close : la mesure a déjà eu lieu");
  const f = o.foyers[foyer];
  if (f.status !== "invited") throw new HttpError(409, `${foyer} a déjà accepté`);

  const c = await getClient();
  const operator = walletFor("operator");
  const w = walletFor(foyer);
  const acc = await acceptOffer(c, w, operator.address, o.hash);
  f.acceptHash = acc.hash;
  f.status = "accepted";
  save(db);

  const { condition } = deriveCondition(secret(), o.hash, w.address);
  const lock = await lockPrime(c, operator, w.address, o.primeXrp, condition);
  f.escrow = { sequence: lock.sequence, condition, cancelAfter: lock.cancelAfter, createHash: lock.hash };
  f.status = "locked";
  save(db);
  return o;
});

/**
 * 4 + 5a. Le vérificateur mesure (simulateur), publie les empreintes des relevés AVANT le verdict,
 * puis libère la prime des foyers qui ont atteint l'objectif. Les autres restent verrouillés.
 * `reductions` : réduction réelle simulée par foyer (0.25 = -25 %).
 */
export const measureAndRelease = (hash, reductions = {}) => serial(async () => {
  const o = findOffer(hash);
  if (o.status !== "open") throw new HttpError(409, "Mesure déjà effectuée");
  const locked = FOYERS.filter((f) => o.foyers[f].status === "locked");
  if (!locked.length) throw new HttpError(409, "Aucun foyer engagé : rien à mesurer");

  const c = await getClient();
  const operator = walletFor("operator");
  const verifier = walletFor("verifier");
  const measures = [];
  for (const f of locked) {
    const r = Math.min(Math.max(Number(reductions[f] ?? 0), 0), 0.9);
    const history = generateHistory(f);
    const { baselineKwh } = computeBaseline(history);
    const measuredKwh = measureEvent(history, r, { foyerId: f });
    const verdict = evaluate({ baselineKwh, measuredKwh, targetReduction: o.targetReduction });
    const rh = releveHash({ offerHash: o.hash, foyer: o.foyers[f].address, slot: o.slot, measuredKwh });
    // Ces valeurs restent hors chaîne (base locale) : seule l'empreinte part on-chain.
    Object.assign(o.foyers[f], {
      baselineKwh, measuredKwh, reduction: verdict.reduction, thresholdKwh: verdict.thresholdKwh,
      releveHash: rh, verdict: verdict.reached ? "reached" : "missed",
    });
    measures.push({ foyer: o.foyers[f].address, releveHash: rh });
  }
  const m = await publishMeasureHash(c, verifier, operator.address, { offerHash: o.hash, measures });
  o.measureHash = m.hash;
  o.status = "measured";
  save(db);

  for (const f of locked) {
    const v = o.foyers[f];
    if (v.verdict !== "reached") continue;
    const { fulfillment } = deriveCondition(secret(), o.hash, v.address);
    const rel = await releasePrime(c, verifier, operator.address, v.escrow.sequence, v.escrow.condition, fulfillment);
    v.status = "released";
    v.settleHash = rel.hash;
    save(db);
  }
  return o;
});

/** 5b. Remboursement à l'opérateur des primes manquées, possible seulement après CancelAfter. */
export const settleOffer = (hash) => serial(async () => {
  const o = findOffer(hash);
  const c = await getClient();
  const verifier = walletFor("verifier");
  const refunded = [];
  const waiting = [];
  for (const [name, v] of Object.entries(o.foyers)) {
    if (v.status !== "locked" || v.verdict !== "missed") continue;
    if (!(await canCancel(c, v.escrow.cancelAfter))) {
      waiting.push({ foyer: name, cancelAfter: new Date(xrpl.rippleTimeToUnixTime(v.escrow.cancelAfter)).toISOString() });
      continue;
    }
    const res = await refundPrime(c, verifier, o.operator, v.escrow.sequence);
    v.status = "refunded";
    v.settleHash = res.hash;
    refunded.push(name);
    save(db);
  }
  if (Object.values(o.foyers).every((v) => v.status !== "locked")) o.status = "closed";
  save(db);
  return { offer: o, refunded, waiting };
});

export function resetLocal() {
  db = { offers: [] };
  save(db);
}
