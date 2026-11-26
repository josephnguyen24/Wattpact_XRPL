// Interface WattPact : appelle l'API locale, qui signe et soumet les transactions au Testnet.
const $ = (s, el = document) => el.querySelector(s);
const FOYERS = ["foyer1", "foyer2", "foyer3"];
const ROLE_LABEL = { operator: "Opérateur", verifier: "Vérificateur", foyer1: "Foyer 1", foyer2: "Foyer 2", foyer3: "Foyer 3" };
const STATUS = {
  invited: ["Invité", "s-invited"],
  accepted: ["Acceptée", "s-accepted"],
  locked: ["Verrouillée", "s-locked"],
  released: ["Libérée", "s-released"],
  refunded: ["Remboursée", "s-refunded"],
};
// Réductions proposées par défaut : 2 réussites, 1 échec (scénario « mixte »)
const DEFAULT_RED = { foyer1: 25, foyer2: 30, foyer3: 5 };

let explorer = "https://testnet.xrpl.org";
let busy = false;
let offers = [];
const sliders = {}; // valeurs des curseurs conservées entre deux rafraîchissements

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const txLink = (hash, label) => (hash ? `<a class="tx" href="${explorer}/transactions/${hash}" target="_blank" rel="noopener">${label}</a>` : "");
const accLink = (addr) => `<a href="${explorer}/accounts/${addr}" target="_blank" rel="noopener">${short(addr)}</a>`;
const RIPPLE_EPOCH = 946684800;

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
  toast.t = setTimeout(() => (t.className = "toast"), err ? 6000 : 3500);
}

/** Exécute une action qui soumet des transactions : boutons désactivés pendant la validation. */
async function action(btn, label, fn, okMsg) {
  if (busy) return;
  busy = true;
  const html = btn.innerHTML;
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  btn.innerHTML = `<span class="spinner"></span>${label}`;
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy = false;
    btn.innerHTML = html;
    await refresh();
  }
}

async function loadAccounts() {
  try {
    const cfg = await api("/accounts");
    explorer = cfg.explorer;
    const net = $("#net");
    net.className = "net ok";
    $("#net-label").textContent = `Testnet · ${cfg.server.replace("wss://", "")}`;
    const form = $("#offer-form");
    if (!form.slot.value) {
      form.slot.value = cfg.defaults.slot;
      form.target.value = Math.round(cfg.defaults.targetReduction * 100);
      form.prime.value = cfg.defaults.primeXrp;
    }
    $("#accounts").innerHTML = Object.entries(cfg.accounts).map(([role, a]) => `
      <li><span><span class="role">${ROLE_LABEL[role]}</span><br>${accLink(a.address)}</span>
      <span class="bal">${a.balance === null ? "compte absent" : `${Number(a.balance).toFixed(2)} XRP`}</span></li>`).join("");
  } catch (e) {
    $("#net").className = "net ko";
    $("#net-label").textContent = `Hors ligne : ${e.message}`;
  }
}

function foyerRow(o, f) {
  const v = o.foyers[f];
  const [label, cls] = STATUS[v.status];
  let verdict = "";
  if (v.verdict) {
    const ok = v.verdict === "reached";
    verdict = `<div class="verdict ${ok ? "ok" : "ko"}">${ok ? "Objectif atteint" : "Objectif manqué"} · −${(v.reduction * 100).toFixed(1)} %</div>`;
  }
  const btn = v.status === "invited" && o.status === "open"
    ? `<button class="btn sm amber" data-accept="${f}">Accepter</button>` : "";
  return `<tr>
    <td><b>${ROLE_LABEL[f]}</b><div class="addr">${accLink(v.address)}</div></td>
    <td><span class="chip ${cls}">${label}</span>${verdict}</td>
    <td class="links">${txLink(v.acceptHash, "acceptation")}${txLink(v.escrow?.createHash, "escrow")}${txLink(v.settleHash, v.status === "refunded" ? "remboursement" : "libération")}</td>
    <td>${btn}</td>
  </tr>`;
}

function measureBlock(o) {
  const locked = FOYERS.filter((f) => o.foyers[f].status === "locked");
  if (o.status === "open") {
    if (!locked.length) return `<div class="measure"><p class="hint" style="margin:0">En attente d'acceptations : chaque foyer signe lui-même, puis l'opérateur verrouille sa prime en escrow.</p></div>`;
    const s = (sliders[o.hash] ||= { ...DEFAULT_RED });
    return `<div class="measure">
      <p class="eyebrow">Vérificateur · gestionnaire de comptage</p>
      <h3>Mesurer l'effacement</h3>
      <p class="hint" style="margin:0">Réduction réelle simulée par foyer. Objectif : au moins −${Math.round(o.targetReduction * 100)} % par rapport à la référence (moyenne des 5 derniers jours comparables).</p>
      <div class="sliders">${locked.map((f) => `
        <div class="slider"><label>${ROLE_LABEL[f]} <output id="out-${o.hash}-${f}">−${s[f]} %</output>
          <input type="range" min="0" max="50" value="${s[f]}" data-slider="${f}"></label></div>`).join("")}
      </div>
      <div class="actions"><button class="btn primary" data-measure>Publier les relevés et régler</button>
      <span class="hint" style="margin:0">Les empreintes des relevés partent on-chain avant le verdict ; la consommation reste hors chaîne.</span></div>
    </div>`;
  }
  const missed = locked.filter((f) => o.foyers[f].verdict === "missed");
  if (!missed.length) return "";
  const ready = missed.every((f) => o.foyers[f].cancellable);
  const ca = Math.max(...missed.map((f) => o.foyers[f].escrow.cancelAfter));
  return `<div class="measure">
    <h3>Primes non gagnées</h3>
    <p class="hint" style="margin:0">Elles restent bloquées jusqu'à <code>CancelAfter</code> : personne, pas même l'opérateur, ne peut les reprendre avant.</p>
    <div class="actions" style="margin-top:10px">
      <button class="btn" data-settle ${ready ? "" : "disabled"}>Rembourser l'opérateur</button>
      <span class="countdown" data-cancel-after="${ca}"></span>
    </div>
  </div>`;
}

function render() {
  $("#empty").hidden = offers.length > 0;
  $("#offers").innerHTML = offers.map((o) => `
    <article class="offer" data-hash="${o.hash}">
      <div class="offer-head">
        <div>
          <p class="offer-title">${esc(o.slot)}</p>
          <div class="terms"><span>Objectif <b>−${Math.round(o.targetReduction * 100)} %</b></span><span>Prime <b>${esc(o.primeXrp)} XRP</b> par foyer</span><span>${new Date(o.createdAt).toLocaleString("fr-FR")}</span></div>
        </div>
        <div class="links" style="text-align:right">${txLink(o.hash, "offre")}${txLink(o.measureHash, "relevés")}</div>
      </div>
      <table class="foyers"><thead><tr><th>Foyer</th><th>Statut</th><th>Transactions</th><th></th></tr></thead>
        <tbody>${FOYERS.map((f) => foyerRow(o, f)).join("")}</tbody></table>
      ${measureBlock(o)}
    </article>`).join("");
  if (busy) document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  tick();
}

function tick() {
  document.querySelectorAll("[data-cancel-after]").forEach((el) => {
    const left = Math.round(Number(el.dataset.cancelAfter) + RIPPLE_EPOCH - Date.now() / 1000);
    el.textContent = left > 0 ? `Remboursement possible dans ${Math.floor(left / 60)} min ${String(left % 60).padStart(2, "0")} s` : "CancelAfter dépassé";
    const btn = el.parentElement.querySelector("[data-settle]");
    if (btn && left <= -5 && !busy) btn.disabled = false; // marge : le ledger doit avoir clos après CancelAfter
  });
}

async function refresh() {
  try {
    offers = await api("/offers");
    render();
  } catch (e) { toast(e.message, true); }
  loadAccounts();
}

// ---------- Événements ----------
$("#offer-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  action(f.querySelector("button"), "Publication…", () => api("/offers", {
    slot: f.slot.value, targetReduction: Number(f.target.value) / 100, primeXrp: f.prime.value,
  }), "Offre publiée sur le ledger");
});

$("#offers").addEventListener("click", (e) => {
  const card = e.target.closest("[data-hash]");
  if (!card) return;
  const hash = card.dataset.hash;
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.accept) {
    const f = b.dataset.accept;
    action(b, "Signature…", () => api(`/offers/${hash}/accept`, { foyer: f }), `${ROLE_LABEL[f]} engagé : prime verrouillée`);
  } else if (b.hasAttribute("data-measure")) {
    const red = Object.fromEntries(Object.entries(sliders[hash]).map(([k, v]) => [k, v / 100]));
    action(b, "Mesure et règlement…", () => api(`/offers/${hash}/measure`, { reductions: red }), "Relevés publiés, primes réglées");
  } else if (b.hasAttribute("data-settle")) {
    action(b, "Remboursement…", async () => {
      const r = await api(`/offers/${hash}/settle`, {});
      if (r.waiting.length) throw new Error("CancelAfter pas encore atteint sur le ledger, réessayez dans quelques secondes");
    }, "Primes manquées rendues à l'opérateur");
  }
});

$("#offers").addEventListener("input", (e) => {
  const s = e.target.closest("[data-slider]");
  if (!s) return;
  const hash = e.target.closest("[data-hash]").dataset.hash;
  sliders[hash][s.dataset.slider] = Number(s.value);
  $(`#out-${hash}-${s.dataset.slider}`).textContent = `−${s.value} %`;
});

setInterval(tick, 1000);
setInterval(() => { if (!busy) refresh(); }, 8000);
refresh();
