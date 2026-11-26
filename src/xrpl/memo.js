import xrpl from "xrpl";

/** Construit un Memo XRPL (type + données JSON, encodés en hexadécimal). */
export function makeMemo(type, data) {
  return {
    Memo: {
      MemoType: xrpl.convertStringToHex(`wattpact/${type}`),
      MemoData: xrpl.convertStringToHex(JSON.stringify(data)),
      MemoFormat: xrpl.convertStringToHex("application/json"),
    },
  };
}

/** Lit le premier Memo d'une transaction et renvoie { type, data }. */
export function readMemo(tx) {
  const m = tx.Memos?.[0]?.Memo;
  if (!m) return null;
  return {
    type: xrpl.convertHexToString(m.MemoType || ""),
    data: JSON.parse(xrpl.convertHexToString(m.MemoData || "")),
  };
}
