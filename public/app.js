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
        <span class="muted small" data-cancel-after="${ca}"></span>`;
    }
    return `<article class="offer">${offerTop(o, txLink(o.measureHash, "relevés"))}
      <table><thead><tr><th>Foyer</th><th>Statut</th><th>Transactions</th></tr></thead><tbody>
      ${FOYERS.map((f) => {
        const v = o.foyers[f];
        return `<tr><td>${NAME[f]}<br>${accLink(v.address)}</td><td>${chip(v.status)}</td>
          <td class="links">${txLink(v.acceptHash, "acceptation")}${txLink(v.escrow?.createHash, "escrow")}${txLink(v.settleHash, v.status === "refunded" ? "remboursement" : "paiement")}</td></tr>`;
      }).join("")}</tbody></table>
      ${foot ? `<div class="offer-foot">${foot}</div>` : ""}
      <div class="offer-foot muted small">${locked}/3 primes engagées</div>
    </article>`;
  }).join("");

  return `<div class="head"><div><h1>Opérateur</h1><p>Finance les primes. Ne décide pas qui est payé.</p></div>${balance("operator")}</div>
  <div class="grid">
    <div class="card"><h2>Nouvelle offre</h2>
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
          <span class="deadline">à publier avant ${hhmm(rippleDate(deadline))} · <span data-deadline="${deadline}"></span></span></div>
        <div class="sliders">${locked.map((f) => `<label>${NAME[f]} <output id="out-${o.hash}-${f}">−${s[f]} %</output>
          <input type="range" min="0" max="50" value="${s[f]}" style="--v:${s[f] * 2}%" data-slider="${f}" data-hash="${o.hash}">
          <span class="target"><span>0 %</span><span>objectif −${pct(o.targetReduction)}</span><span>−50 %</span></span></label>`).join("")}</div>
        <div class="offer-foot"><button class="btn main" data-act="measure" data-hash="${o.hash}">Publier les relevés</button>
          <span class="muted small">On-chain : l'empreinte de chaque relevé, pas la consommation.</span></div>
      </article>`;
    }
    return `<article class="offer">${offerTop(o, txLink(o.measureHash, "relevés"))}
      <table><thead><tr><th>Foyer</th><th>Référence</th><th>Mesuré</th><th>Baisse</th><th></th></tr></thead><tbody>
      ${FOYERS.filter((f) => o.foyers[f].verdict).map((f) => {
        const v = o.foyers[f];
        const ok = v.verdict === "reached";
        return `<tr><td>${NAME[f]}</td><td class="mono">${v.baselineKwh} kWh</td><td class="mono">${v.measuredKwh} kWh</td>
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
      <div class="offer-foot">${chip(v.status)}<span class="small">${info}</span></div>
      ${proofs[`${o.hash}:${f}`] || ""}
      <div class="offer-foot">${action}${txLink(v.acceptHash, "mon acceptation")}${txLink(v.settleHash, v.status === "refunded" ? "remboursement" : "paiement")}</div>
    </article>`;
  }).join("");
  const anyInvited = offers.some((o) => o.status === "open" && FOYERS.some((x) => o.foyers[x].status === "invited"));
  return `<div class="head"><div><h1>${NAME[f]}</h1><p>${accLink(me.address)}</p></div>${balance(f)}</div>
    ${list || `<div class="empty">Aucune offre reçue.</div>`}
    ${anyInvited ? `<p><button class="btn link" data-act="accept-all">démo : faire accepter les 3 foyers d'un coup</button></p>` : ""}`;
}

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

function render() {
  if (!cfg) return;
  const r = role();
  document.querySelectorAll("#roles a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${r}`));
  $("#view").innerHTML = r === "verificateur" ? viewVerifier() : FOYERS.includes(r) ? viewFoyer(r) : viewOperator();
  if (busy) document.querySelectorAll("#view button").forEach((b) => (b.disabled = true));
  stats();
  tick();
}

function stats() {
  const sum = (st) => offers.reduce((t, o) => t + FOYERS.filter((f) => o.foyers[f].status === st).length * Number(o.primeXrp), 0);
  const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
  $("#st-locked").textContent = fmt(sum("locked"));
  $("#st-paid").textContent = fmt(sum("released"));
  $("#st-refunded").textContent = fmt(sum("refunded"));
}

function tick() {
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    const left = Math.round(Number(el.dataset.deadline) + RIPPLE_EPOCH - Date.now() / 1000) - 15;
    el.textContent = left > 0 ? `reste ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "trop tard";
    el.parentElement.classList.toggle("ko", left <= 30);
  });
  document.querySelectorAll("[data-cancel-after]").forEach((el) => {
    const left = Math.round(Number(el.dataset.cancelAfter) + RIPPLE_EPOCH - Date.now() / 1000);
    el.textContent = left > 0 ? `possible dans ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "échéance passée";
    const btn = el.parentElement.querySelector("button");
    if (btn && left <= -5 && !busy) btn.disabled = false;
  });
}

async function refresh() {
  try {
    const [a, o] = await Promise.all([api("/accounts"), api("/offers")]);
    cfg = a;
    offers = o;
    $("#net").className = "net ok";
    $("#net-label").textContent = `Testnet · ${a.server.replace("wss://", "")}`;
    // ne pas casser un champ en cours de saisie
    if (!document.activeElement?.closest?.("form")) render();
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
});

window.addEventListener("hashchange", render);
setInterval(tick, 1000);
setInterval(() => { if (!busy) refresh(); }, 4000);
refresh();
