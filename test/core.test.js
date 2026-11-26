import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { conditionFromPreimage, deriveCondition, randomCondition } from "../src/xrpl/conditions.js";
import { generateHistory, measureEvent } from "../src/offchain/simulator.js";
import { computeBaseline, evaluate, releveHash } from "../src/offchain/verifier.js";

test("condition PREIMAGE-SHA-256 : format et cohérence hash/préimage", () => {
  const pre = Buffer.alloc(32, 7);
  const { condition, fulfillment } = conditionFromPreimage(pre);
  const hash = createHash("sha256").update(pre).digest("hex").toUpperCase();
  assert.equal(condition, `A0258020${hash}810120`);
  assert.equal(fulfillment, `A0228020${pre.toString("hex").toUpperCase()}`);
  assert.equal(condition.length, 78);
});

test("condition : préimage de mauvaise taille refusée", () => {
  assert.throws(() => conditionFromPreimage(Buffer.alloc(16)));
});

test("valeur secrète dérivée : déterministe, distincte par foyer", () => {
  const a1 = deriveCondition("secret", "OFFRE1", "rFoyerA");
  const a2 = deriveCondition("secret", "OFFRE1", "rFoyerA");
  const b = deriveCondition("secret", "OFFRE1", "rFoyerB");
  assert.deepEqual(a1, a2);
  assert.notEqual(a1.condition, b.condition);
  assert.notEqual(randomCondition().condition, randomCondition().condition);
});

test("simulateur : déterministe", () => {
  assert.deepEqual(generateHistory("foyer1"), generateHistory("foyer1"));
  assert.notDeepEqual(generateHistory("foyer1"), generateHistory("foyer2"));
});

test("baseline : moyenne de 5 jours de semaine comparables", () => {
  const h = generateHistory("foyer1");
  const { baselineKwh, days } = computeBaseline(h);
  assert.equal(days.length, 5);
  assert.ok(baselineKwh > 0);
});

test("baseline : historique insuffisant refusé", () => {
  assert.throws(() => computeBaseline(generateHistory("foyer1").slice(-2)));
});

test("verdict : -25 % atteint l'objectif -20 %, -5 % non", () => {
  const h = generateHistory("foyer1");
  const { baselineKwh } = computeBaseline(h);
  const ok = evaluate({ baselineKwh, measuredKwh: measureEvent(h, 0.25, { foyerId: "foyer1" }), targetReduction: 0.2 });
  const ko = evaluate({ baselineKwh, measuredKwh: measureEvent(h, 0.05, { foyerId: "foyer1" }), targetReduction: 0.2 });
  assert.equal(ok.reached, true);
  assert.equal(ko.reached, false);
});

test("verdict : seuil exact (limite) atteint", () => {
  assert.equal(evaluate({ baselineKwh: 10, measuredKwh: 8, targetReduction: 0.2 }).reached, true);
  assert.equal(evaluate({ baselineKwh: 10, measuredKwh: 8.01, targetReduction: 0.2 }).reached, false);
});

test("empreinte du relevé : indépendante de l'ordre des clés, sensible aux valeurs", () => {
  const a = releveHash({ x: 1, y: 2 });
  assert.equal(a, releveHash({ y: 2, x: 1 }));
  assert.notEqual(a, releveHash({ x: 1, y: 3 }));
  assert.match(a, /^[0-9a-f]{64}$/);
});
