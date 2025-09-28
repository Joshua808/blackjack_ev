import React, { useMemo, useState } from "react";

type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
const RANKS: Rank[] = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function rankValue(r: Rank): number {
  if (r === "A") return 11;
  if (r === "J" || r === "Q" || r === "K" || r === "10") return 10;
  return parseInt(r, 10);
}

type Rules = {
  decks: number;
  dealerHitsSoft17: boolean;
  blackjackPays: 1.5 | 1.2;
  lateSurrender: boolean;
  doubleAllowed: boolean;
  doubleAfterSplit: boolean;
  resplitPairs: number;
  splitAcesOneCardOnly: boolean;
  resplitAces: boolean;
};

const DEFAULT_RULES: Rules = {
  decks: 6,
  dealerHitsSoft17: true,
  blackjackPays: 1.5,
  lateSurrender: true,
  doubleAllowed: true,
  doubleAfterSplit: true,
  resplitPairs: 3,
  splitAcesOneCardOnly: true,
  resplitAces: false,
};

type Hand = Rank[];

function handTotals(cards: Hand): { hard: number; soft: number | null; isSoft: boolean; best: number } {
  let total = 0; let aces = 0;
  for (const r of cards) { if (r === "A") aces++; else total += rankValue(r); }
  let best = total;
  for (let i = 0; i < aces; i++) {
    if (best + 11 <= 21 - (aces - 1 - i)) best += 11; else best += 1;
  }
  const isSoft = aces > 0 && best <= 21 && (best - total - (aces - 1)) === 11;
  const hard = total + aces * 1;
  const soft = isSoft ? best : null;
  return { hard, soft, isSoft, best: isSoft ? best : hard };
}
function isBlackjack(cards: Hand): boolean { return cards.length === 2 && handTotals(cards).best === 21 && cards.includes("A"); }
function isBust(cards: Hand): boolean { return handTotals(cards).best > 21; }
function normalizeRank(r: Rank): string { return r === "J" || r === "Q" || r === "K" ? "10" : r; }
function canSplit(cards: Hand): boolean { return cards.length === 2 && normalizeRank(cards[0]) === normalizeRank(cards[1]); }

// ===== Finite shoe model =====
type Shoe = Record<Rank, number>;
function makeFullShoe(decks: number): Shoe {
  const s: Shoe = { A:0, "2":0, "3":0, "4":0, "5":0, "6":0, "7":0, "8":0, "9":0, "10":0, J:0, Q:0, K:0 };
  for (const r of RANKS) s[r] = 4 * decks; // 4 of each rank per deck
  return s;
}
function shoeTotal(s: Shoe): number { let t = 0; for (const r of RANKS) t += s[r]; return t; }
function shoeKey(s: Shoe): string { return RANKS.map(r=>s[r]).join(","); }
function draw(s: Shoe, r: Rank){ s[r]--; }
function undraw(s: Shoe, r: Rank){ s[r]++; }
function cloneShoe(s: Shoe): Shoe { const c: Shoe = {A:0,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0,"8":0,"9":0,"10":0,J:0,Q:0,K:0}; for (const r of RANKS) c[r]=s[r]; return c; }

function initShoe(decks: number, player: Hand, dealerUp: Rank): Shoe {
  const s = makeFullShoe(decks);
  const remove = (r: Rank) => { if (s[r] <= 0) return; s[r]--; };
  for (const r of player) remove(r);
  remove(dealerUp);
  return s;
}

// Dealer distribution (finite shoe)
function dealerOutcomeProbs(upcard: Rank, shoeStart: Shoe, rules: Rules): Record<string, number> {
  const memo = new Map<string, Record<string, number>>();

  function probsFor(cards: Hand, shoe: Shoe): Record<string, number> {
    const t = handTotals(cards);
    const key = `${t.best}|${t.isSoft?'S':'H'}|${shoeKey(shoe)}`;
    if (memo.has(key)) return memo.get(key)!;

    // natural 21\n
    if (cards.length === 2 && t.best === 21) { const out = {\"21\":1} as Record<string, number>; memo.set(key, out); return out; }
    const shouldStand = () => {
      if (t.best > 21) return false;
      if (t.isSoft) { if (t.best > 17) return true; if (t.best === 17) return !rules.dealerHitsSoft17; return false; }
      return t.best >= 17;
    };
    if (t.best > 21) { const out = { bust: 1 } as Record<string, number>; memo.set(key, out); return out; }
    if (shouldStand()) { const out = { [String(t.best)]: 1 } as Record<string, number>; memo.set(key, out); return out; }

    const out: Record<string, number> = {};
    const tot = shoeTotal(shoe);
    if (tot === 0) { memo.set(key, out); return out; }
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue;
      const p = shoe[r] / tot;
      draw(shoe, r);
      const next = probsFor([...cards, r], shoe);
      undraw(shoe, r);
      for (const k of Object.keys(next)) out[k] = (out[k] || 0) + p * next[k];
    }
    memo.set(key, out);
    return out;
  }

  // draw hole card from shoeStart
  const dist: Record<string, number> = {};
  const tot = shoeTotal(shoeStart);
  for (const r of RANKS) {
    if (shoeStart[r] <= 0) continue;
    const p = shoeStart[r] / tot;
    draw(shoeStart, r);
    const next = probsFor([upcard, r], shoeStart);
    undraw(shoeStart, r);
    for (const k of Object.keys(next)) dist[k] = (dist[k] || 0) + p * next[k];
  }
  return dist;
}

type PlayerContext = {
  rules: Rules;
  upcard: Rank;
  canDouble: boolean;
  canSplit: boolean;
  splitDepth: number;
  isSplitAces: boolean;
  doubleAfterSplit?: boolean;
};

function evStand(player: Hand, upcard: Rank, rules: Rules, shoe: Shoe): number {
  const pt = handTotals(player).best; if (pt > 21) return -1;
  const dist = dealerOutcomeProbs(upcard, shoe, rules); let ev = 0;
  for (const k of Object.keys(dist)) {
    const p = dist[k];
    if (k === "bust") ev += p * 1;
    else { const dt = parseInt(k, 10); if (pt > dt) ev += p; else if (pt < dt) ev -= p; }
  }
  return ev;
}

function evInitialBlackjack(upcard: Rank, rules: Rules, shoe: Shoe): number {
  const dist = dealerOutcomeProbs(upcard, shoe, rules);
  const pDealerBJ = dist["21"] || 0;
  const payout = rules.blackjackPays;
  return (1 - pDealerBJ) * payout;
}

function handKey(hand: Hand): string {
  const counts: Record<string, number> = {}; for (const r of hand.map(normalizeRank)) counts[r] = (counts[r] || 0) + 1;
  return Object.entries(counts).sort().map(([r, c]) => `${r}x${c}`).join(",");
}

function bestActionEV(hand: Hand, ctx: PlayerContext, shoe: Shoe, cache: Map<string, number>): number {
  const t = handTotals(hand);
  const key = [handKey(hand), `pt=${t.best}${t.isSoft?'S':'H'}`, `up=${ctx.upcard}`, `cd=${ctx.canDouble?1:0}`, `cs=${ctx.canSplit?1:0}`, `sd=${ctx.splitDepth}`, `sa=${ctx.isSplitAces?1:0}`, `H17=${ctx.rules.dealerHitsSoft17?1:0}`, `SR=${ctx.rules.lateSurrender?1:0}`, `shoe=${shoeKey(shoe)}`].join('|');
  if (cache.has(key)) return cache.get(key)!;

  if (isBust(hand)) { cache.set(key, -1); return -1; }
  const initial = hand.length === 2 && ctx.splitDepth === 0;
  if (initial && isBlackjack(hand)) { const v = evInitialBlackjack(ctx.upcard, ctx.rules, shoe); cache.set(key, v); return v; }

  // Stand
  const standEV = evStand(hand, ctx.upcard, ctx.rules, shoe);

  // Hit
  let hitEV = 0; const tot = shoeTotal(shoe);
  for (const r of RANKS) {
    if (shoe[r] <= 0) continue;
    const p = shoe[r] / tot;
    draw(shoe, r);
    const next = [...hand, r];
    const v = (ctx.isSplitAces && ctx.rules.splitAcesOneCardOnly) ? evStand(next, ctx.upcard, ctx.rules, shoe) : bestActionEV(next, ctx, shoe, cache);
    undraw(shoe, r);
    hitEV += p * v;
  }

  // Double
  let doubleEV = Number.NEGATIVE_INFINITY;
  if (ctx.canDouble && hand.length === 2 && ctx.rules.doubleAllowed) {
    let v2 = 0; const tot2 = shoeTotal(shoe);
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue; const p = shoe[r]/tot2; draw(shoe, r);
      v2 += p * evStand([...hand, r], ctx.upcard, ctx.rules, shoe);
      undraw(shoe, r);
    }
    doubleEV = 2 * v2;
  }

  // Surrender
  const surrenderEV = (ctx.rules.lateSurrender && hand.length === 2 && ctx.splitDepth === 0) ? -0.5 : Number.NEGATIVE_INFINITY;

  // Split
  let splitEV = Number.NEGATIVE_INFINITY;
  if (ctx.canSplit && hand.length === 2 && (normalizeRank(hand[0]) === normalizeRank(hand[1]))) {
    const splittingAces = hand[0] === "A" && hand[1] === "A";
    const canResplit = ctx.splitDepth < ctx.rules.resplitPairs && (splittingAces ? ctx.rules.resplitAces : true);
    let left = 0, right = 0; const totS = shoeTotal(shoe);
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue; const p = shoe[r]/totS; draw(shoe, r);
      const childCtx: PlayerContext = { ...ctx, canDouble: ctx.doubleAfterSplit, canSplit: canResplit, splitDepth: ctx.splitDepth + 1, isSplitAces: splittingAces };
      const leftEV  = splittingAces && ctx.rules.splitAcesOneCardOnly ? evStand([hand[0], r], ctx.upcard, ctx.rules, shoe) : bestActionEV([hand[0], r], childCtx, shoe, cache);
      const rightEV = splittingAces && ctx.rules.splitAcesOneCardOnly ? evStand([hand[1], r], ctx.upcard, ctx.rules, shoe) : bestActionEV([hand[1], r], childCtx, shoe, cache);
      undraw(shoe, r);
      left += p * leftEV; right += p * rightEV;
    }\n    splitEV = left + right;\n  }\n\n  const best = Math.max(standEV, hitEV, doubleEV, surrenderEV, splitEV);\n  cache.set(key, best); return best;\n}\n\nfunction actionEVsFinite(hand: Hand, ctx: PlayerContext, shoe: Shoe): { [action: string]: number } {\n  const cache = new Map<string, number>(); const res: Record<string, number> = {};\n  res[\"Stand\"] = evStand(hand, ctx.upcard, ctx.rules, shoe);\n\n  // Hit\n  let hitEV = 0; const tot = shoeTotal(shoe);\n  for (const r of RANKS) {\n    if (shoe[r] <= 0) continue; const p = shoe[r]/tot; draw(shoe, r);\n    const v = (ctx.isSplitAces && ctx.rules.splitAcesOneCardOnly) ? evStand([...hand, r], ctx.upcard, ctx.rules, shoe) : bestActionEV([...hand, r], ctx, shoe, cache);\n    undraw(shoe, r);\n    hitEV += p * v;\n  }\n  res[\"Hit\"] = hitEV;\n\n  // Double\n  if (ctx.canDouble && hand.length === 2 && ctx.rules.doubleAllowed) {\n    let v2 = 0; const tot2 = shoeTotal(shoe);\n    for (const r of RANKS) { if (shoe[r] <= 0) continue; const p = shoe[r]/tot2; draw(shoe, r); v2 += p * evStand([...hand, r], ctx.upcard, ctx.rules, shoe); undraw(shoe, r); }\n    res[\"Double\"] = 2 * v2;\n  }\n\n  if (ctx.rules.lateSurrender && hand.length === 2 && ctx.splitDepth === 0) res[\"Surrender\"] = -0.5;\n\n  // Split\n  if (hand.length === 2 && (normalizeRank(hand[0]) === normalizeRank(hand[1]))) {\n    const splittingAces = hand[0] === \"A\" && hand[1] === \"A\";\n    const canResplit = ctx.splitDepth < ctx.rules.resplitPairs && (splittingAces ? ctx.rules.resplitAces : true);\n    let left = 0, right = 0; const totS = shoeTotal(shoe);\n    for (const r of RANKS) {\n      if (shoe[r] <= 0) continue; const p = shoe[r]/totS; draw(shoe, r);\n      const childCtx: PlayerContext = { ...ctx, canDouble: ctx.doubleAfterSplit, canSplit: canResplit, splitDepth: ctx.splitDepth + 1, isSplitAces: splittingAces };\n      const leftEV  = splittingAces && ctx.rules.splitAcesOneCardOnly ? evStand([hand[0], r], ctx.upcard, ctx.rules, shoe) : bestActionEV([hand[0], r], childCtx, shoe, cache);\n      const rightEV = splittingAces && ctx.rules.splitAcesOneCardOnly ? evStand([hand[1], r], ctx.upcard, ctx.rules, shoe) : bestActionEV([hand[1], r], childCtx, shoe, cache);\n      undraw(shoe, r);\n      left += p * leftEV; right += p * rightEV;\n    }\n    res[\"Split\"] = left + right;\n  }\n\n  if (hand.length === 2 && isBlackjack(hand)) res[\"Blackjack\"] = evInitialBlackjack(ctx.upcard, ctx.rules, shoe);\n  return res;\n}\n\nconst CardPicker: React.FC<{ label: string; cards: Hand; setCards: (h: Hand) => void; maxCards?: number; }>\n= ({ label, cards, setCards, maxCards = 2 }) => (\n  <div className=\"flex flex-col gap-2\">\n    <div className=\"text-sm font-medium\">{label}</div>\n    <div className=\"flex gap-2 items-center flex-wrap\">\n      {cards.map((c, i) => (\n        <div key={i} className=\"flex items-center gap-2\">\n          <select className=\"border rounded-xl px-3 py-2 text-sm\" value={c} onChange={e => { const next = [...cards]; next[i] = e.target.value as Rank; setCards(next); }}>\n            {RANKS.map(r => <option key={r} value={r}>{r}</option>)}\n          </select>\n          <button className=\"text-xs text-gray-600 underline\" onClick={() => setCards(cards.filter((_, idx) => idx !== i))}>remove</button>\n        </div>\n      ))}\n      {cards.length < maxCards && (\n        <button className=\"border rounded-xl px-3 py-2 text-sm\" onClick={() => setCards([...cards, \"A\"]) }>+ Add card</button>\n      )}\n    </div>\n  </div>\n);\n\nconst Toggle: React.FC<{label: string; checked: boolean; onChange: (v:boolean)=>void}>\n= ({ label, checked, onChange }) => (\n  <label className=\"flex items-center justify-between gap-4 py-2\">\n    <span className=\"text-sm\">{label}</span>\n    <input type=\"checkbox\" checked={checked} onChange={e=>onChange(e.target.checked)} />\n  </label>\n);\n\nconst NumberInput: React.FC<{label:string; value:number; onChange:(n:number)=>void; min?:number; max?:number}>\n= ({label, value, onChange, min=0, max=10}) => (\n  <label className=\"flex items-center justify-between gap-4 py-2\">\n    <span className=\"text-sm\">{label}</span>\n    <input type=\"number\" className=\"border rounded px-2 py-1 w-20\" value={value} min={min} max={max} step={1} onChange={e=>onChange(parseInt(e.target.value||\"0\",10))} />\n  </label>\n);\n\nfunction formatEV(ev: number | undefined): string { if (ev === undefined || !isFinite(ev)) return \"—\"; return (ev >= 0 ? \"+\" : \"\") + ev.toFixed(4); }\nfunction bestMoveFrom(evs: Record<string, number>): { move: string; ev: number } { let bestM = \"Stand\"; let bestV = -Infinity; for (const [k,v] of Object.entries(evs)) { if (v > bestV) { bestV = v; bestM = k; } } return { move: bestM, ev: bestV }; }\n\nexport default function App() {\n  const [player, setPlayer] = useState<Hand>([\"A\",\"7\"]);\n  const [dealerUp, setDealerUp] = useState<Rank>(\"6\");\n  const [rules, setRules] = useState<Rules>({...DEFAULT_RULES});\n  const canSplitFlag = useMemo(()=> canSplit(player), [player]);\n  const ctx: PlayerContext = useMemo(()=>({ rules, upcard: dealerUp, canDouble: player.length === 2, canSplit: canSplitFlag, splitDepth: 0, isSplitAces: false, doubleAfterSplit: rules.doubleAfterSplit }), [rules, dealerUp, canSplitFlag, player.length]);\n\n  const baseShoe = useMemo(()=> initShoe(rules.decks, player, dealerUp), [rules.decks, player, dealerUp]);\n  const evs = useMemo(()=> actionEVsFinite(player, ctx, baseShoe), [player, ctx, baseShoe]);\n  const best = useMemo(()=> bestMoveFrom(evs), [evs]);\n  const pt = handTotals(player);\n\n  return (\n    <div className=\"min-h-screen w-full bg-gray-50\">\n      <div className=\"max-w-6xl mx-auto px-6 py-8\">\n        <h1 className=\"text-2xl font-semibold mb-2\">PA Blackjack EV Helper — Finite Decks</h1>\n        <p className=\"text-sm text-gray-700 mb-6\">Choose cards, set rules (including deck count), and see the optimal move with expected value computed from a finite shoe.</p>\n        <div className=\"grid grid-cols-1 md:grid-cols-3 gap-6\">\n          <div className=\"md:col-span-2\">\n            <div className=\"grid grid-cols-1 lg:grid-cols-2 gap-6\">\n              <div className=\"bg-white rounded-2xl shadow p-4\">\n                <CardPicker label=\"Player Cards\" cards={player} setCards={setPlayer} maxCards={10} />\n                <div className=\"mt-3 text-xs text-gray-600\">Total: <b>{pt.best}</b> {pt.isSoft ? \"(soft)\" : \"(hard)\"} {isBlackjack(player) && <span className=\"ml-1\">• Blackjack</span>}</div>\n                <div className=\"mt-3 text-xs text-gray-600\">Pair: {canSplitFlag ? <b>Yes</b> : \"No\"}</div>\n              </div>\n              <div className=\"bg-white rounded-2xl shadow p-4\">\n                <div className=\"text-sm font-medium mb-2\">Dealer Upcard</div>\n                <select className=\"border rounded-xl px-3 py-2 text-sm\" value={dealerUp} onChange={e=>setDealerUp(e.target.value as Rank)}>\n                  {RANKS.map(r => <option key={r} value={r}>{r}</option>)}\n                </select>\n                <div className=\"mt-4 text-xs text-gray-600 leading-relaxed\">\n                  <p className=\"mb-2\">Finite-shoe recursion with memoization keyed by hand state and remaining-card composition.</p>\n                </div>\n              </div>\n            </div>\n            <div className=\"mt-6 bg-white rounded-2xl shadow p-4\">\n              <div className=\"flex items-center justify-between mb-3\">\n                <h2 className=\"text-lg font-semibold\">Results</h2>\n                <div className=\"text-sm text-gray-600\">Best Move: <span className=\"font-semibold\">{best.move}</span> <span className=\"ml-2\">EV: <span className={best.ev>=0?\"text-green-600\":\"text-red-600\"}>{formatEV(best.ev)}</span></span></div>\n              </div>\n              <div className=\"overflow-x-auto\">\n                <table className=\"w-full text-sm\">\n                  <thead>\n                    <tr className=\"text-left border-b\"><th className=\"py-2 pr-4\">Action</th><th className=\"py-2\">EV</th></tr>\n                  </thead>\n                  <tbody>\n                    {Object.entries(evs).sort((a,b)=>b[1]-a[1]).map(([k,v])=> (\n                      <tr key={k} className=\"border-b last:border-b-0\"><td className=\"py-2 pr-4\">{k}</td><td className=\"py-2 font-mono\">{formatEV(v)}</td></tr>\n                    ))}\n                  </tbody>\n                </table>\n              </div>\n            </div>\n          </div>\n          <div className=\"bg-white rounded-2xl shadow p-4 h-fit\">\n            <h2 className=\"text-lg font-semibold mb-2\">Rules</h2>\n            <label className=\"flex items-center justify-between gap-4 py-2\">\n              <span className=\"text-sm\">Decks</span>\n              <select className=\"border rounded px-2 py-1\" value={rules.decks} onChange={e=>setRules({...rules, decks: parseInt(e.target.value,10) as number})}>\n                {[1,2,3,4,5,6,7,8].map(n=> <option key={n} value={n}>{n}</option>)}\n              </select>\n            </label>\n            <Toggle label=\"Dealer hits soft 17 (H17)\" checked={rules.dealerHitsSoft17} onChange={v=>setRules({...rules, dealerHitsSoft17: v})} />\n            <Toggle label=\"Late surrender\" checked={rules.lateSurrender} onChange={v=>setRules({...rules, lateSurrender: v})} />\n            <Toggle label=\"Double on any 2 cards\" checked={rules.doubleAllowed} onChange={v=>setRules({...rules, doubleAllowed: v})} />\n            <Toggle label=\"Double after split (DAS)\" checked={rules.doubleAfterSplit} onChange={v=>setRules({...rules, doubleAfterSplit: v})} />\n            <NumberInput label=\"Resplit pairs (times)\" value={rules.resplitPairs} min={0} max={6} onChange={n=>setRules({...rules, resplitPairs: n})} />\n            <Toggle label=\"Split Aces: one card only\" checked={rules.splitAcesOneCardOnly} onChange={v=>setRules({...rules, splitAcesOneCardOnly: v})} />\n            <Toggle label=\"Allow resplit Aces\" checked={rules.resplitAces} onChange={v=>setRules({...rules, resplitAces: v})} />\n            <div className=\"mt-4 text-xs text-gray-600\">\n              <p><b>Note:</b> Finite-shoe EVs can be computationally heavier than infinite-deck. If you see slowness with many added cards, try reducing decks or cards.</p>\n            </div>\n          </div>\n        </div>\n        <div className=\"mt-8 text-center text-xs text-gray-500\">© {new Date().getFullYear()} Blackjack EV Helper • Finite deck engine.</div>\n      </div>\n    </div>\n  );\n}\n