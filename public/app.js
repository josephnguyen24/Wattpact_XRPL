// WattPact : une vue par acteur. L'API signe pour l'opérateur, le vérificateur et les foyers
// (comptes de test). La vue foyer relit ses preuves directement sur le ledger, sans notre API.
const $ = (s, el = document) => el.querySelector(s);
const FOYERS = ["foyer1", "foyer2", "foyer3"];
const NAME = { operator: "Opérateur", verifier: "Vérificateur", foyer1: "Foyer 1", foyer2: "Foyer 2", foyer3: "Foyer 3" };
const STATUS = {
  invited: ["en attente", ""],
  accepted: ["acceptée", "s-accepted"],
  locked: ["prime bloquée", "s-locked"],
  released: ["payée", "s-released"],
  refunded: ["remboursée", "s-refunded"],
};
const RIPPLE_EPOCH = 946684800;

let cfg = null;
let offers = [];
let busy = false;
const sliders = {}; // offre -> { foyer: % }
const proofs = {}; // `${offre}:${foyer}` -> html

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const explorer = () => cfg?.explorer || "https://testnet.xrpl.org";
const txLink = (h, label) => (h ? `<a class="tx" href="${explorer()}/transactions/${h}" target="_blank" rel="noopener">${label}</a>` : "");
const accLink = (a) => `<a class="addr" href="${explorer()}/accounts/${a}" target="_blank" rel="noopener">${short(a)}</a>`;
const chip = (st) => `<span class="chip ${STATUS[st][1]}">${STATUS[st][0]}</span>`;
const pct = (x) => `${Math.round(x * 100)} %`;
const rippleDate = (t) => new Date((t + RIPPLE_EPOCH) * 1000);
const hhmm = (d) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function api(path, body) {
  const res = await fetch(`/api${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${err ? " err" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = "toast"), err ? 6000 : 3000);
}

async function run(btn, label, fn, ok) {
  if (busy) return;
  busy = true;
  const html = btn.innerHTML;
  document.querySelectorAll("#view button").forEach((b) => (b.disabled = true));
  btn.innerHTML = `<span class="spinner"></span>${label}`;
  const t0 = performance.now();
  try {
    await fn();
    if (ok) toast(`${ok} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy = false;
    btn.innerHTML = html;
    await refresh();
  }
}

// ---------- créneau ----------
const isoDay = (plus) => {
  const d = new Date();
  d.setDate(d.getDate() + plus);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const hourOptions = (sel) =>
  Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sel ? "selected" : ""}>${h}h</option>`).join("");
function slotLabel(day, from, to) {
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  return `${date}, ${from}h-${to}h`;
}
function readSlot(f) {
  const from = Number(f.from.value);
  const to = Number(f.to.value);
  if (to <= from) throw new Error("L'heure de fin doit être après l'heure de début");
  if (f.day.value < isoDay(0)) throw new Error("Le créneau doit être aujourd'hui ou plus tard");
  return slotLabel(f.day.value, from, to);
}
// valeurs du formulaire gardées entre deux rafraîchissements
const draft = { day: isoDay(1), from: 18, to: 20, target: null, prime: null };

function updatePreview(f) {
  Object.assign(draft, { day: f.day.value, from: Number(f.from.value), to: Number(f.to.value), target: f.target.value, prime: f.prime.value });
  const p = $("#slot-preview");
  try {
    p.textContent = readSlot(f);
    p.className = "small muted";
  } catch (e) {
    p.textContent = e.message;
    p.className = "small ko";
  }
}

const role = () => (location.hash.slice(1) || "operateur");

// ---------- vues ----------

function offerTop(o, right = "") {
  return `<div class="offer-top">
    <div><h3>${esc(o.slot)}</h3>
      <div class="terms"><span>objectif <b>−${pct(o.targetReduction)}</b></span><span>prime <b>${esc(o.primeXrp)} XRP</b></span><span>${new Date(o.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span></div>
    </div>
    <div class="links">${txLink(o.hash, "offre")}${right}</div>
  </div>`;
}

function viewOperator() {
  const d = cfg.defaults;
  const list = offers.map((o) => {
    const accepted = FOYERS.filter((f) => o.foyers[f].status === "accepted");
    // récupérable : objectif manqué, ou échéance passée sans mesure (le ledger n'autorise plus que le remboursement)
    const missed = FOYERS.filter((f) => o.foyers[f].status === "locked" && (o.foyers[f].verdict === "missed" || o.foyers[f].cancellable));
    const locked = FOYERS.filter((f) => ["locked", "released", "refunded"].includes(o.foyers[f].status)).length;
    let foot = "";
    if (accepted.length) {
      foot = `<button class="btn main" data-act="lock" data-hash="${o.hash}">Bloquer ${accepted.length} prime${accepted.length > 1 ? "s" : ""}</button>
        <span class="muted small">${accepted.length * Number(o.primeXrp)} XRP mis sous séquestre</span>`;
    } else if (missed.length) {
      const ca = Math.max(...missed.map((f) => o.foyers[f].escrow.cancelAfter));
      foot = `<button class="btn" data-act="settle" data-hash="${o.hash}" ${missed.every((f) => o.foyers[f].cancellable) ? "" : "disabled"}>Récupérer ${missed.length * Number(o.primeXrp)} XRP</button>
        ${ring(`<span class="muted small" data-cancel-after="${ca}"></span>`)}`;
    }
    return `<article class="offer">${offerTop(o, txLink(o.measureHash, "relevés"))}
      <table><thead><tr><th>Foyer</th><th>Statut</th><th>Transactions</th></tr></thead><tbody>
      ${FOYERS.map((f) => {
        const v = o.foyers[f];
        return `<tr data-key="${o.hash}:${f}" data-status="${v.status}"><td>${NAME[f]}<br>${accLink(v.address)}</td><td>${chip(v.status)}${pipe(v.status)}</td>
          <td class="links">${txLink(v.acceptHash, "acceptation")}${txLink(v.escrow?.createHash, "escrow")}${txLink(v.settleHash, v.status === "refunded" ? "remboursement" : "paiement")}</td></tr>`;
      }).join("")}</tbody></table>
      ${foot ? `<div class="offer-foot">${foot}</div>` : ""}
      <div class="offer-foot muted small">${locked}/3 primes engagées</div>
    </article>`;
  }).join("");

  return `<div class="head"><div><h1>Opérateur</h1><p>Finance les primes. Ne décide pas qui est payé.</p></div>${balance("operator")}</div>
  <div class="grid">
    <div class="stack"><div class="card"><h2>Nouvelle offre</h2>
      <form id="offer-form">
        <label>Jour <input name="day" type="date" required min="${isoDay(0)}" value="${draft.day}"></label>
        <div class="row2">
          <label>De <select name="from">${hourOptions(draft.from)}</select></label>
          <label>À <select name="to">${hourOptions(draft.to)}</select></label>
        </div>
        <div class="presets">
          <button type="button" class="btn sm" data-preset="18-20">Pointe soir 18h-20h</button>
          <button type="button" class="btn sm" data-preset="7-9">Pointe matin 7h-9h</button>
        </div>
        <p class="small muted" id="slot-preview">${slotLabel(draft.day, draft.from, draft.to)}</p>
        <div class="row2">
          <label>Objectif <span class="unit"><input name="target" type="number" min="1" max="99" value="${draft.target ?? Math.round(d.targetReduction * 100)}" required>%</span></label>
          <label>Prime <span class="unit"><input name="prime" type="number" min="0.1" max="20" step="0.1" value="${draft.prime ?? d.primeXrp}" required>XRP</span></label>
        </div>
        <button class="btn main" type="submit">Publier</button>
      </form>
    </div>
    <div class="card"><h2>Trésorerie</h2>
      <p class="small muted" style="margin:0 0 10px">Après l'échéance, une prime non versée ne peut plus que revenir à l'opérateur.</p>
      <div class="presets">
        <button class="btn sm" data-act="recover">Récupérer les primes expirées</button>
        <button class="btn sm" data-act="topup">Recharger au faucet</button>
      </div>
    </div></div>
    <div>${list || `<div class="empty">Pas encore d'offre.</div>`}</div>
  </div>`;
}

function viewVerifier() {
  const list = offers.filter((o) => FOYERS.some((f) => o.foyers[f].status !== "invited")).map((o) => {
    const locked = FOYERS.filter((f) => o.foyers[f].status === "locked");
    if (o.status === "open") {
      if (!locked.length) return `<article class="offer">${offerTop(o)}<div class="offer-foot muted small">En attente des escrows de l'opérateur.</div></article>`;
      const s = (sliders[o.hash] ||= { foyer1: 25, foyer2: 30, foyer3: 5 });
      const deadline = Math.min(...locked.map((f) => o.foyers[f].escrow.cancelAfter));
      if (locked.some((f) => o.foyers[f].cancellable)) {
        return `<article class="offer">${offerTop(o)}<div class="offer-foot small ko">Échéance passée à ${hhmm(rippleDate(deadline))} sans mesure : le ledger n'autorise plus le paiement, seulement le remboursement de l'opérateur.</div></article>`;
      }
      return `<article class="offer">${offerTop(o)}
        <div class="offer-foot small"><span class="muted">Relevés simulés : baisse réelle de chaque foyer sur le créneau.</span>
          <span class="deadline">${ring(`<span>à publier avant ${hhmm(rippleDate(deadline))} · <span data-deadline="${deadline}"></span></span>`)}</span></div>
        <div class="charts">${locked.map((f) => `<div>
          ${chartBlock(o, f, predicted(f, s[f] / 100), false, `<output id="out-${o.hash}-${f}">−${s[f]} %</output>`)}
          <label class="slider"><span class="sr">Baisse de ${NAME[f]}</span>
            <input type="range" min="0" max="50" value="${s[f]}" style="--v:${s[f] * 2}%" data-slider="${f}" data-hash="${o.hash}">
            <span class="target"><span>0 %</span><span>objectif −${pct(o.targetReduction)}</span><span>−50 %</span></span></label>
        </div>`).join("")}</div>
        <div class="offer-foot"><button class="btn main" data-act="measure" data-hash="${o.hash}">Publier les relevés</button>
          <span class="muted small">On-chain : l'empreinte de chaque relevé, pas la consommation.</span></div>
      </article>`;
    }
    const measuredF = FOYERS.filter((f) => o.foyers[f].verdict);
    return `<article class="offer">${offerTop(o, txLink(o.measureHash, "relevés"))}
      <div class="charts">${measuredF.map((f) => chartBlock(o, f, o.foyers[f].measuredKwh, true,
        `<span class="mono ${o.foyers[f].verdict === "reached" ? "ok" : "ko"}">−${(o.foyers[f].reduction * 100).toFixed(1)} %</span>`)).join("")}</div>
      <table><thead><tr><th>Foyer</th><th>Référence</th><th>Mesuré</th><th>Baisse</th><th></th></tr></thead><tbody>
      ${measuredF.map((f) => {
        const v = o.foyers[f];
        const ok = v.verdict === "reached";
        return `<tr data-key="${o.hash}:${f}" data-status="${v.status}"><td>${NAME[f]}</td><td class="mono">${v.baselineKwh} kWh</td><td class="mono">${v.measuredKwh} kWh</td>
          <td class="mono ${ok ? "ok" : "ko"}">−${(v.reduction * 100).toFixed(1)} %</td>
          <td>${ok ? `${txLink(v.settleHash, "libérée")}` : `<span class="muted small">non atteint</span>`}</td></tr>`;
      }).join("")}</tbody></table></article>`;
  }).join("");
  return `<div class="head"><div><h1>Vérificateur</h1><p>Mesure et tranche. Ne peut pas toucher l'argent : l'escrow ne paie que le foyer.</p></div>${balance("verifier")}</div>
    ${list || `<div class="empty">Rien à mesurer pour l'instant.</div>`}`;
}

function viewFoyer(f) {
  const me = cfg.accounts[f];
  const list = offers.map((o) => {
    const v = o.foyers[f];
    let action = "";
    if (v.status === "invited" && o.status === "open") action = `<button class="btn main" data-act="accept" data-hash="${o.hash}" data-foyer="${f}">Accepter</button>`;
    if (v.status !== "invited") action += `<button class="btn" data-act="verify" data-hash="${o.hash}" data-foyer="${f}">Vérifier sur le ledger</button>`;
    let info = "";
    if (v.status === "accepted") info = "En attente de l'escrow de l'opérateur.";
    if (v.status === "locked" && !v.verdict) info = `${o.primeXrp} XRP bloqués à ton nom.`;
    if (v.verdict) info = `Baisse mesurée : −${(v.reduction * 100).toFixed(1)} % (objectif −${pct(o.targetReduction)}).`;
    return `<article class="offer">${offerTop(o)}
      <div class="offer-foot" data-key="${o.hash}:${f}" data-status="${v.status}">${chip(v.status)}<span class="small">${info}</span>${pipe(v.status)}</div>
      ${v.status !== "invited" ? `<div class="charts one">${chartBlock(o, f, v.verdict ? v.measuredKwh : undefined, true,
        v.verdict ? "" : `<span class="muted small">ma conso sur le créneau, 10 derniers jours</span>`)}</div>` : ""}
      ${proofs[`${o.hash}:${f}`] || ""}
      <div class="offer-foot">${action}${txLink(v.acceptHash, "mon acceptation")}${txLink(v.settleHash, v.status === "refunded" ? "remboursement" : "paiement")}</div>
    </article>`;
  }).join("");
  const anyInvited = offers.some((o) => o.status === "open" && FOYERS.some((x) => o.foyers[x].status === "invited"));
  return `<div class="head"><div><h1>${NAME[f]}</h1><p>${accLink(me.address)}</p></div>${balance(f)}</div>
    ${list || `<div class="empty">Aucune offre reçue.</div>`}
    ${anyInvited ? `<p><button class="btn link" data-act="accept-all">démo : faire accepter les 3 foyers d'un coup</button></p>` : ""}`;
}

// ---------- graphique de consommation d'un foyer (créneau de pointe, 10 jours + jour J) ----------

let hist = null; // { foyer1: { history, baselineKwh }, ... } : données simulées, hors chaîne
const CW = 340, CH = 176, PL = 36, PR = 12, PT = 14, PB = 26;

/**
 * kwhJ : conso du jour J (mesurée, ou estimée pendant qu'on règle le curseur).
 * measured : true si c'est la vraie mesure publiée.
 */
function chart(f, targetReduction, kwhJ, measured) {
  const h = hist?.[f];
  if (!h) return "";
  const days = h.history;
  const base = h.baselineKwh;
  const threshold = base * (1 - targetReduction);
  const vals = [...days.map((d) => d.kwh), base, threshold, kwhJ ?? base];
  const lo = Math.min(...vals) * 0.85, hi = Math.max(...vals) * 1.06;
  const n = days.length + 1;
  const x = (i) => PL + (i * (CW - PL - PR)) / (n - 1);
  const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (CH - PT - PB);
  const pts = days.map((d, i) => [x(i), y(d.kwh)]);
  const line = pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)} ${b.toFixed(1)}`).join(" ");
  const area = `${line} L${pts.at(-1)[0].toFixed(1)} ${CH - PB} L${PL} ${CH - PB} Z`;
  const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15];
  const reached = kwhJ !== undefined && kwhJ <= threshold;
  const jx = x(n - 1), jy = kwhJ === undefined ? null : y(kwhJ);
  const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const tipData = days.map((d) => ({ x: x(days.indexOf(d)), y: y(d.kwh), t: `${new Date(`${d.date}T12:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} · ${d.kwh.toFixed(3)} kWh${d.weekday === 0 || d.weekday === 6 ? " · week-end, hors référence" : ""}` }));
  if (jy !== null) tipData.push({ x: jx, y: jy, t: `jour J · ${measured ? "" : "≈ "}${kwhJ.toFixed(3)} kWh · ${reached ? "objectif atteint" : "objectif manqué"}` });

  return `<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Consommation de ${NAME[f]} sur le créneau de pointe, 10 derniers jours et jour J"
      data-tips='${esc(JSON.stringify(tipData))}'>
    <defs><linearGradient id="g-${f}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ad000" stop-opacity=".22"/><stop offset="1" stop-color="#7ad000" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((t) => `<line class="grid" x1="${PL}" x2="${CW - PR}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${PL - 6}" y="${y(t) + 3}" text-anchor="end">${t.toFixed(1)}</text>`).join("")}
    <rect class="zone" x="${PL}" y="${y(threshold)}" width="${CW - PL - PR}" height="${CH - PB - y(threshold)}"/>
    <line class="thr" x1="${PL}" x2="${CW - PR}" y1="${y(threshold)}" y2="${y(threshold)}"/>
    <text class="lbl thr-l" x="${PL + 4}" y="${y(threshold) + 12}">objectif −${pct(targetReduction)}</text>
    <line class="base" x1="${PL}" x2="${CW - PR}" y1="${y(base)}" y2="${y(base)}"/>
    <path class="area" d="${area}" fill="url(#g-${f})"/>
    <path class="ln" d="${line}"/>
    <text class="lbl" x="${CW - PR - 4}" y="${y(base) - 5}" text-anchor="end">référence ${base.toFixed(2)}</text>
    ${pts.map(([a, b], i) => `<circle class="${days[i].weekday === 0 || days[i].weekday === 6 ? "we" : "pt"}" cx="${a}" cy="${b}" r="3.5"/>`).join("")}
    ${jy !== null ? `<path class="to-j" d="M${pts.at(-1)[0]} ${pts.at(-1)[1]} L${jx} ${jy}"/>
      <circle class="j ${reached ? "ok" : "ko"} ${measured ? "" : "pred"}" cx="${jx}" cy="${jy}" r="5.5"/>` : ""}
    ${days.map((d, i) => (i % 2 === 0 ? `<text class="ax" x="${x(i)}" y="${CH - 8}" text-anchor="middle">${dm(d.date)}</text>` : "")).join("")}
    <text class="ax j-l" x="${jx}" y="${CH - 8}" text-anchor="middle">J</text>
    <line class="cross" x1="0" x2="0" y1="${PT}" y2="${CH - PB}"/>
    <rect class="hit" x="${PL}" y="0" width="${CW - PL - PR}" height="${CH}"/>
  </svg>`;
}

/** Bloc graphique + légende compacte (une seule série : le titre la nomme). */
function chartBlock(o, f, kwhJ, measured, extra = "") {
  return `<div class="chart-box" data-chart="${o.hash}:${f}">
    <div class="chart-head"><b>${NAME[f]}</b>${extra}</div>
    ${chart(f, o.targetReduction, kwhJ, measured)}
  </div>`;
}

const predicted = (f, r) => (hist?.[f] ? hist[f].baselineKwh * (1 - r) : undefined);

function balance(r) {
  const b = cfg.accounts[r]?.balance;
  return `<div style="text-align:right"><div class="big">${b === null || b === undefined ? "?" : Number(b).toFixed(2)} <small>XRP</small></div><div class="muted small">solde Testnet</div></div>`;
}

// ---------- preuve lue sur le ledger depuis le navigateur ----------

let ledgerClient;
async function ledger() {
  if (ledgerClient?.isConnected()) return ledgerClient;
  for (const url of cfg.servers) {
    try {
      const c = new xrpl.Client(url, { connectionTimeout: 6000 });
      await c.connect();
      return (ledgerClient = c);
    } catch { /* serveur suivant */ }
  }
  throw new Error("Testnet injoignable depuis le navigateur");
}
const txJson = (r) => r.result.tx_json ?? r.result;
const memoOf = (tx) => JSON.parse(xrpl.convertHexToString(tx.Memos[0].Memo.MemoData));

async function verify(o, f) {
  const c = await ledger();
  const v = o.foyers[f];
  const items = [];
  const add = (ok, text) => items.push(`<li><span class="${ok ? "ok" : "ko"}">${ok ? "✓" : "✗"}</span><span>${text}</span></li>`);

  const offerTx = txJson(await c.request({ command: "tx", transaction: o.hash }));
  const terms = memoOf(offerTx);
  add(offerTx.Account === o.operator, `Offre signée par l'opérateur : ${esc(terms.slot)}, −${pct(terms.targetReduction)}, ${esc(terms.primeXrp)} XRP`);

  if (v.acceptHash) {
    const acc = txJson(await c.request({ command: "tx", transaction: v.acceptHash }));
    add(acc.Account === v.address && memoOf(acc).offerHash === o.hash, "Mon acceptation, signée par moi, pointe bien vers cette offre");
  }

  if (v.escrow) {
    try {
      const e = (await c.request({ command: "ledger_entry", escrow: { owner: o.operator, seq: v.escrow.sequence }, ledger_index: "validated" })).result.node;
      add(e.Destination === v.address, "L'escrow ne peut payer que mon adresse");
      add(Number(xrpl.dropsToXrp(e.Amount)) === Number(terms.primeXrp), `${xrpl.dropsToXrp(e.Amount)} XRP bloqués, comme promis dans l'offre`);
      add(true, `L'opérateur ne peut rien reprendre avant ${hhmm(rippleDate(e.CancelAfter))}`);
    } catch (err) {
      if (err?.data?.error !== "entryNotFound") throw err;
      if (v.settleHash) {
        const s = await c.request({ command: "tx", transaction: v.settleHash });
        const t = txJson(s);
        const okTx = (s.result.meta?.TransactionResult) === "tesSUCCESS";
        if (t.TransactionType === "EscrowFinish") add(okTx, "Escrow terminé : la prime a été versée sur mon compte");
        else add(okTx, "Objectif manqué : la prime est retournée à l'opérateur après l'échéance");
      }
    }
  }

  if (o.measureHash) {
    const m = memoOf(txJson(await c.request({ command: "tx", transaction: o.measureHash })));
    const mine = m.measures.find((x) => x.foyer === v.address);
    add(Boolean(mine), `Empreinte de mon relevé publiée : <code>${mine ? mine.releveHash.slice(0, 16) : "?"}…</code>`);
  }

  return `<div class="proof"><h4>Ce que dit le ledger</h4><ul>${items.join("")}</ul>
    <div class="src">lu directement sur ${esc(c.url)}, sans passer par le serveur WattPact</div></div>`;
}

// ---------- rendu et événements ----------

// ---------- éléments animés ----------

const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Frise acceptée → bloquée → payée / remboursée ; l'étape en cours clignote. */
function pipe(status) {
  const order = ["accepted", "locked", "final"];
  const at = status === "invited" ? -1 : status === "accepted" ? 0 : status === "locked" ? 1 : 2;
  const end = status === "refunded" ? "red" : "green";
  return `<span class="pipe ${end}" aria-hidden="true">${order.map((_, i) =>
    `${i ? `<i class="seg ${i <= at ? "lit" : ""}"></i>` : ""}<i class="node ${i < at ? "lit" : i === at ? "lit now" : ""}"></i>`).join("")}</span>`;
}

/** Anneau de compte à rebours autour d'un texte. */
const ring = (inner) =>
  `<span class="ring-wrap"><svg class="ring" viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/><circle class="fg" cx="18" cy="18" r="15" pathLength="100"/></svg>${inner}</span>`;
function setRing(el, left, total) {
  const fg = el.closest(".ring-wrap")?.querySelector(".fg");
  if (fg) fg.style.strokeDashoffset = String(100 - Math.max(0, Math.min(1, left / total)) * 100);
}

// statuts déjà vus : une ligne qui change de statut clignote
const seen = new Map();
let enter = true;

function render() {
  if (!cfg) return;
  const r = role();
  document.querySelectorAll("#roles a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${r}`));
  const view = $("#view");
  view.innerHTML = r === "verificateur" ? viewVerifier() : FOYERS.includes(r) ? viewFoyer(r) : viewOperator();
  if (enter && motion) {
    view.querySelectorAll(".offer, .card, .empty").forEach((el, i) => {
      el.classList.add("enter");
      el.style.animationDelay = `${i * 70}ms`;
    });
  }
  enter = false;
  // changements de statut détectés sur les données (pas sur ce qui était affiché avant)
  const strikes = [];
  for (const o of offers) {
    for (const f of FOYERS) {
      const key = `${o.hash}:${f}`;
      const now = o.foyers[f].status;
      const prev = seen.get(key);
      seen.set(key, now);
      if (!prev || prev === now || !motion) continue;
      const el = view.querySelector(`[data-key="${key}"]`);
      if (!el) continue;
      el.classList.add("flash", `flash-${now}`);
      if (now === "released") strikes.push(el);
    }
  }
  if (busy) document.querySelectorAll("#view button").forEach((b) => (b.disabled = true));
  stats();
  tick();
  strikes.forEach((el, i) => setTimeout(() => bolt(el), i * 180));
}

/** Éclair du compteur « sous séquestre » vers la ligne du foyer payé. */
function bolt(target) {
  const a = $("#st-locked").getBoundingClientRect();
  const t = (target.querySelector(".chip") || target).getBoundingClientRect();
  if (!t.width) return;
  const x1 = a.left + a.width / 2, y1 = a.top + a.height / 2;
  const x2 = t.left + t.width / 2, y2 = t.top + t.height / 2;
  const segs = 9;
  let d = `M${x1} ${y1}`;
  for (let i = 1; i < segs; i++) {
    const k = i / segs;
    const nx = -(y2 - y1), ny = x2 - x1, len = Math.hypot(nx, ny) || 1;
    const off = (Math.random() - 0.5) * 70 * Math.sin(Math.PI * k);
    d += ` L${x1 + (x2 - x1) * k + (nx / len) * off} ${y1 + (y2 - y1) * k + (ny / len) * off}`;
  }
  d += ` L${x2} ${y2}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "bolt-fx");
  svg.innerHTML = `<path class="glow-p" d="${d}" pathLength="100"/><path class="core" d="${d}" pathLength="100"/><circle class="hit-c" cx="${x2}" cy="${y2}" r="4"/>`;
  document.body.appendChild(svg);
  setTimeout(() => svg.remove(), 1100);
}

/** Les montants du bandeau défilent jusqu'à leur nouvelle valeur. */
function countTo(el, value) {
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = value;
  const fmt = (n) => (Number.isInteger(value) ? Math.round(n) : n.toFixed(1));
  if (from === value) return;
  if (!motion) return void (el.textContent = fmt(value));
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 700);
    el.textContent = fmt(from + (value - from) * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function stats() {
  const sum = (st) => offers.reduce((t, o) => t + FOYERS.filter((f) => o.foyers[f].status === st).length * Number(o.primeXrp), 0);
  countTo($("#st-locked"), sum("locked"));
  countTo($("#st-paid"), sum("released"));
  countTo($("#st-refunded"), sum("refunded"));
}

function tick() {
  const total = cfg?.cancelAfterSeconds || 180;
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    const left = Math.round(Number(el.dataset.deadline) + RIPPLE_EPOCH - Date.now() / 1000) - 15;
    el.textContent = left > 0 ? `reste ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "trop tard";
    el.closest(".deadline").classList.toggle("ko", left <= 30);
    setRing(el, left, total - 15);
  });
  document.querySelectorAll("[data-cancel-after]").forEach((el) => {
    const left = Math.round(Number(el.dataset.cancelAfter) + RIPPLE_EPOCH - Date.now() / 1000);
    el.textContent = left > 0 ? `possible dans ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "échéance passée";
    setRing(el, left, total);
    const btn = el.closest(".offer-foot").querySelector("button");
    if (btn && left <= -5 && !busy) btn.disabled = false;
  });
}

/** Numéro du dernier ledger validé, en direct depuis le Testnet (abonnement au flux « ledger »). */
async function liveLedger() {
  try {
    const c = await ledger();
    const show = (n) => {
      $("#ledger-n").textContent = `#${n}`;
      const el = $("#ledger");
      el.classList.remove("tick");
      void el.offsetWidth;
      el.classList.add("tick");
    };
    c.on("ledgerClosed", (l) => show(l.ledger_index));
    const r = await c.request({ command: "subscribe", streams: ["ledger"] });
    show(r.result.ledger_index);
  } catch {
    $("#ledger").hidden = true;
  }
}

async function refresh() {
  try {
    const [a, o] = await Promise.all([api("/accounts"), api("/offers")]);
    const first = !cfg;
    cfg = a;
    offers = o;
    if (first) {
      liveLedger();
      hist = await api("/history").catch(() => null);
    }
    $("#net").className = "net ok";
    $("#net-label").textContent = `Testnet · ${a.server.replace("wss://", "")}`;
    // ne pas casser un champ en cours de saisie
    const editing = document.activeElement?.closest?.("form") || document.activeElement?.type === "range";
    if (!editing && !document.querySelector("svg.chart.hover")) render();
  } catch (e) {
    $("#net").className = "net ko";
    $("#net-label").textContent = e.message;
  }
}

$("#view").addEventListener("submit", (e) => {
  if (e.target.id !== "offer-form") return;
  e.preventDefault();
  const f = e.target;
  let slot;
  try {
    slot = readSlot(f);
  } catch (err) {
    return toast(err.message, true);
  }
  run(f.querySelector("button[type=submit]"), "Publication…", () => api("/offers", {
    slot, targetReduction: Number(f.target.value) / 100, primeXrp: f.prime.value,
  }), "Offre publiée");
});

$("#view").addEventListener("change", (e) => {
  const f = e.target.closest("#offer-form");
  if (f) updatePreview(f);
});

$("#view").addEventListener("click", async (e) => {
  const p = e.target.closest("[data-preset]");
  if (p) {
    const f = p.closest("form");
    const [from, to] = p.dataset.preset.split("-");
    f.from.value = from;
    f.to.value = to;
    updatePreview(f);
    return;
  }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const { act, hash, foyer } = b.dataset;
  if (act === "accept") run(b, "Signature…", () => api(`/offers/${hash}/accept`, { foyer }), "Offre acceptée");
  if (act === "accept-all") {
    const o = offers.find((x) => x.status === "open" && FOYERS.some((f) => x.foyers[f].status === "invited"));
    run(b, "Signatures…", () => api(`/offers/${o.hash}/accept`, { foyer: FOYERS }), "3 foyers ont accepté");
  }
  if (act === "recover") {
    run(b, "Lecture du ledger…", async () => {
      const r = await api("/operator/recover", {});
      toast(`${r.count} escrow${r.count > 1 ? "s" : ""} remboursé${r.count > 1 ? "s" : ""} : ${r.recovered} XRP récupérés`);
    });
  }
  if (act === "topup") run(b, "Faucet…", () => api("/operator/topup", {}), "Opérateur rechargé");
  if (act === "lock") run(b, "Envoi des escrows…", () => api(`/offers/${hash}/lock`, {}), "Primes bloquées");
  if (act === "measure") {
    const red = Object.fromEntries(Object.entries(sliders[hash]).map(([k, v]) => [k, v / 100]));
    run(b, "Publication…", () => api(`/offers/${hash}/measure`, { reductions: red }), "Relevés publiés, primes réglées");
  }
  if (act === "settle") run(b, "Remboursement…", () => api(`/offers/${hash}/settle`, {}), "Primes récupérées");
  if (act === "verify") {
    const o = offers.find((x) => x.hash === hash);
    b.disabled = true;
    b.innerHTML = `<span class="spinner"></span>Lecture du ledger…`;
    try {
      proofs[`${hash}:${foyer}`] = await verify(o, foyer);
    } catch (err) {
      toast(err.message, true);
    }
    render();
  }
});

$("#view").addEventListener("input", (e) => {
  const form = e.target.closest("#offer-form");
  if (form) return updatePreview(form);
  const s = e.target.closest("[data-slider]");
  if (!s) return;
  sliders[s.dataset.hash][s.dataset.slider] = Number(s.value);
  s.style.setProperty("--v", `${s.value * 2}%`);
  $(`#out-${s.dataset.hash}-${s.dataset.slider}`).textContent = `−${s.value} %`;
  // le point du jour J suit le curseur
  const o = offers.find((x) => x.hash === s.dataset.hash);
  const box = document.querySelector(`[data-chart="${s.dataset.hash}:${s.dataset.slider}"] svg`);
  if (o && box) box.outerHTML = chart(s.dataset.slider, o.targetReduction, predicted(s.dataset.slider, s.value / 100), false);
});

// réticule + infobulle au survol d'un graphique
const tip = document.createElement("div");
tip.className = "tip";
document.body.appendChild(tip);
$("#view").addEventListener("pointermove", (e) => {
  const svg = e.target.closest?.("svg.chart");
  if (!svg) return void tip.classList.remove("on");
  const pts = JSON.parse(svg.dataset.tips);
  const r = svg.getBoundingClientRect();
  const vx = ((e.clientX - r.left) / r.width) * CW;
  const p = pts.reduce((a, b) => (Math.abs(b.x - vx) < Math.abs(a.x - vx) ? b : a));
  const cross = svg.querySelector(".cross");
  cross.setAttribute("x1", p.x);
  cross.setAttribute("x2", p.x);
  svg.classList.add("hover");
  tip.textContent = p.t;
  tip.style.left = `${r.left + (p.x / CW) * r.width}px`;
  tip.style.top = `${r.top + (p.y / CH) * r.height - 12}px`;
  tip.classList.add("on");
});
$("#view").addEventListener("pointerleave", () => tip.classList.remove("on"), true);
$("#view").addEventListener("pointerout", (e) => {
  const svg = e.target.closest?.("svg.chart");
  if (svg && !svg.contains(e.relatedTarget)) {
    svg.classList.remove("hover");
    tip.classList.remove("on");
  }
});

// halo qui suit la souris, avec un léger retard
(() => {
  const g = $("#glow");
  if (!g || matchMedia("(hover: none), (prefers-reduced-motion: reduce)").matches) return;
  let x = innerWidth / 2, y = innerHeight / 2, gx = x, gy = y, raf = 0;
  const band = $(".band");
  const step = () => {
    gx += (x - gx) * 0.18;
    gy += (y - gy) * 0.18;
    g.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
    raf = Math.abs(x - gx) + Math.abs(y - gy) > 0.5 ? requestAnimationFrame(step) : 0;
  };
  addEventListener("pointermove", (e) => {
    x = e.clientX;
    y = e.clientY;
    g.classList.add("on");
    g.classList.toggle("dark", y < band.getBoundingClientRect().bottom);
    if (!raf) raf = requestAnimationFrame(step);
  }, { passive: true });
  document.addEventListener("pointerleave", () => g.classList.remove("on"));
})();

window.addEventListener("hashchange", () => {
  enter = true;
  render();
});
setInterval(tick, 1000);
setInterval(() => { if (!busy) refresh(); }, 4000);
refresh();
