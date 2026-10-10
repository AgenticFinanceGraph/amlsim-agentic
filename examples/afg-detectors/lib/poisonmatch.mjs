/* The address-poisoning matcher, on its own so it can be tested. Moved verbatim from poison.mjs on
   10 Oct 2026; poison.mjs imports it. Nothing here touches the chain or the database.

   A recipient is a look-alike of a payee when its first 4 and last 4 hex characters match (what
   wallets and agents display); the last 4 alone counts only for a fake-symbol token, a rule the
   caller applies. norm() strips combining marks and invisible characters and maps confusable
   letters to the Latin ones they imitate before a symbol is compared with the canonical set. */
/* Confusable letters seen in fake-token symbols, mapped to the Latin letter they imitate. */
export const CONF = { "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "К": "K", "М": "M", "О": "O", "Р": "P", "Т": "T", "Х": "X", "У": "Y", "а": "A", "с": "C", "е": "E", "о": "O", "р": "P", "х": "X", "у": "Y", "Ѕ": "S", "ѕ": "S", "Ꭰ": "D", "Ꮪ": "S", "Ⴝ": "S", "Ꮯ": "C", "ꓚ": "C", "ꓢ": "S", "ꓓ": "D", "ꓴ": "U", "Τ": "T", "Ε": "E", "Α": "A", "Β": "B", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Χ": "X", "Υ": "Y", "Ζ": "Z", "ϲ": "C", "Ꭼ": "E", "Ꭲ": "T", "Ꮃ": "W", "ı": "I", "ⅼ": "L", "Ⅽ": "C", "Ⅾ": "D" };
export const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ]/g;
export function norm(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ᪰-᫿᷀-᷿⃐-⃿]/g, "").replace(INVISIBLE, "")
    .split("").map((c) => CONF[c] || c).join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
export const f4 = (a) => a.slice(2, 6), l4 = (a) => a.slice(-4);
/* payees of one wallet, indexed by first4+last4 and by last4 (a scan per log was quadratic) */
export function payeeIndex(list, first) {
  const k8 = new Map(), k4 = new Map();
  /* earliest-paid first, so a label names the counterparty the wallet knew longest */
  list = [...list].sort((a, b) => (first.get(a) || 0) - (first.get(b) || 0));
  for (const r of list) {
    const a = f4(r) + l4(r), b = l4(r);
    if (!k8.has(a)) k8.set(a, []); k8.get(a).push(r);
    if (!k4.has(b)) k4.set(b, []); k4.get(b).push(r);
  }
  return { set: new Set(list), k8, k4, first };
}
export function lookalike(p, ix, at) {
  if (!ix) return null;
  const t = at ? at.getTime() : Infinity;
  const pick = (arr) => { const c = arr.filter((r) => r !== p); return c.find((r) => (ix.first.get(r) || 0) < t) || c[0]; };
  const s = pick(ix.k8.get(f4(p) + l4(p)) || []);
  if (s) return { r: s, m: "f4l4" };
  const w = pick(ix.k4.get(l4(p)) || []);
  return w ? { r: w, m: "l4" } : null;
}
