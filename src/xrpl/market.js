import xrpl from "xrpl";
import { makeMemo } from "./memo.js";
import { submit, ledgerCloseRippleTime } from "./client.js";
import { CANCEL_AFTER_SECONDS } from "../config.js";

const ONE_DROP = "1"; // transaction "porte-message" : le Memo est l'information, pas le montant

/**
 * 1. Offre : l'opérateur publie créneau, objectif et prime (Payment + Memo vers le vérificateur).
 * Le hash de cette transaction sert d'identifiant d'offre (figé à la publication).
 */
export async function publishOffer(client, operator, verifierAddress, offer) {
  return submit(client, operator, {
    TransactionType: "Payment",
    Account: operator.address,
    Destination: verifierAddress,
    Amount: ONE_DROP,
    Memos: [makeMemo("offer", offer)],
  });
}

/** 2. Acceptation : le foyer signe lui-même, en référençant le hash de l'offre. */
export async function acceptOffer(client, foyer, operatorAddress, offerHash) {
  return submit(client, foyer, {
    TransactionType: "Payment",
    Account: foyer.address,
    Destination: operatorAddress,
    Amount: ONE_DROP,
    Memos: [makeMemo("accept", { offerHash })],
  });
}

/**
 * 3. Verrouillage : l'opérateur bloque la prime dans un escrow conditionnel.
 * Libération : valeur secrète du vérificateur. Échec : EscrowCancel possible après CancelAfter.
 */
export async function lockPrime(client, operator, foyerAddress, primeXrp, condition) {
  const cancelAfter = xrpl.isoTimeToRippleTime(
    new Date(Date.now() + CANCEL_AFTER_SECONDS * 1000).toISOString(),
  );
  const out = await submit(client, operator, {
    TransactionType: "EscrowCreate",
    Account: operator.address,
    Destination: foyerAddress,
    Amount: xrpl.xrpToDrops(primeXrp),
    Condition: condition,
    CancelAfter: cancelAfter,
  });
  return { ...out, sequence: out.result.tx_json.Sequence, cancelAfter };
}

/** Construit un EscrowCreate sans le soumettre (pour les envois groupés). */
export function escrowCreateTx(operatorAddress, foyerAddress, primeXrp, condition) {
  const cancelAfter = xrpl.isoTimeToRippleTime(new Date(Date.now() + CANCEL_AFTER_SECONDS * 1000).toISOString());
  return {
    cancelAfter,
    tx: {
      TransactionType: "EscrowCreate",
      Account: operatorAddress,
      Destination: foyerAddress,
      Amount: xrpl.xrpToDrops(primeXrp),
      Condition: condition,
      CancelAfter: cancelAfter,
    },
  };
}

/** 4. Mesure : le vérificateur publie le hash du relevé (jamais la consommation). */
export function measureTx(verifierAddress, operatorAddress, payload) {
  return {
    TransactionType: "Payment",
    Account: verifierAddress,
    Destination: operatorAddress,
    Amount: ONE_DROP,
    Memos: [makeMemo("measure", payload)],
  };
}

export async function publishMeasureHash(client, verifier, operatorAddress, payload) {
  return submit(client, verifier, measureTx(verifier.address, operatorAddress, payload));
}

/** 5a. Libération : le vérificateur révèle la Fulfillment, la prime va au foyer. */
export async function releasePrime(client, submitter, owner, sequence, condition, fulfillment) {
  return submit(client, submitter, {
    TransactionType: "EscrowFinish",
    Account: submitter.address,
    Owner: owner,
    OfferSequence: sequence,
    Condition: condition,
    Fulfillment: fulfillment,
  });
}

/** 5b. Remboursement : possible seulement après CancelAfter, la prime revient à l'opérateur. */
export async function refundPrime(client, submitter, owner, sequence) {
  return submit(client, submitter, {
    TransactionType: "EscrowCancel",
    Account: submitter.address,
    Owner: owner,
    OfferSequence: sequence,
  });
}

/** Vrai si CancelAfter est dépassé selon l'heure du dernier ledger validé. */
export async function canCancel(client, cancelAfter) {
  return (await ledgerCloseRippleTime(client)) > cancelAfter;
}
