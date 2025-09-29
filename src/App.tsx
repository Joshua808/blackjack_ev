import React, { useMemo, useState } from "react";

/** ---------- Types & constants ---------- */
type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
const RANKS: Rank[] = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function rankValue(r: Rank): number {
  if (r === "A") return 11;
  if (r === "J" || r === "Q" || r === "K" || r === "10") return 10;
  return parseInt(r, 10);
}

type Rules = {
  decks: number;
  dealerHitsSoft17: boolean;         // H17 (true) / S17 (false)
  blackjackPays: 1.5 | 1.2;          // 3:2 or 6:5
  lateSurrender: boolean;
  doubleAllowed: boolean;
  doubleAfterSplit: boolean;
  resplitPairs: number;               // e.g., 3
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

/** ---------- Hand utilities ---------- */
function handTotals(cards: Hand): { hard: number; soft: number | null; isSoft: boolean; best: number } {
  let total = 0; let aces = 0;
  for (const r of cards) { if (r === "A") aces++; else total += rankValue(r); }
  let best = total;
  for (let i = 0; i < aces; i++) {
    // try to place 11 without bust; remaining aces count as 1
    if (best + 11 <= 21 - (aces - 1 - i)) best += 11;
    else best += 1;
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

/** ---------- Finite shoe model ---------- */
type Shoe = Record<Rank, number>;

function makeFullShoe(decks: number): Shoe {
  const s: Shoe = { A:0, "2":0, "3":0, "4":0, "5":0, "6":0, "7":0, "8":0, "9":0, "10":0, J:0, Q:0, K:0 };
  for (const r of RANKS) s[r] = 4 * decks;
  return s;
}
function shoeTotal(s: Shoe): number { let t = 0; for (const r of RANKS) t += s[r]; return t; }
function draw(s: Shoe, r: Rank){ s[r]--; }
function undraw(s: Shoe, r: Rank){ s[r]++; }
function shoeKey(s: Shoe): string { return RANKS.map(r=>s[r]).join(","); }

function initShoeMulti(decks: number, hands: Hand[], dealerUp: Rank): Shoe {
  const s = makeFullShoe(decks);
  const remove = (r: Rank) => { if (s[r] > 0) s[r]--; };
  for (const h of hands) for (const r of h) remove(r);
  remove(dealerUp);
  return s;
}

/** ---------- Dealer distribution with finite shoe ---------- */
function dealerOutcomeProbs(upcard: Rank, shoeStart: Shoe, rules: Rules): Record<string, number> {
  const memo = new Map<string, Record<string, number>>();

  function probsFor(cards: Hand, shoe: Shoe): Record<string, number> {
    const t = handTotals(cards);
    const key = `${t.best}|${t.isSoft ? "S" : "H"}|${shoeKey(shoe)}`;
    if (memo.has(key)) return memo.get(key)!;

    // Natural 21 (two-card 21)
    if (cards.length === 2 && t.best === 21) {
      const out: Record<string, number> = { "21": 1 };
      memo.set(key, out);
      return out;
    }

    const shouldStand = (): boolean => {
      if (t.best > 21) return false;
      if (t.isSoft) {
        if (t.best > 17) return true;
        if (t.best === 17) return !rules.dealerHitsSoft17; // stand on soft 17 if S17
        return false;
      }
      return t.best >= 17;
    };

    if (t.best > 21) {
      const out: Record<string, number> = { bust: 1 };
      memo.set(key, out);
      return out;
    }
    if (shouldStand()) {
      const out: Record<string, number> = { [String(t.best)]: 1 };
      memo.set(key, out);
      return out;
    }

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

/** ---------- EV engine (finite shoe, recursion + memo) ---------- */
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
  const pt = handTotals(player).best;
  if (pt > 21) return -1;
  const dist = dealerOutcomeProbs(upcard, shoe, rules);
  let ev = 0;
  for (const k of Object.keys(dist)) {
    const p = dist[k];
    if (k === "bust") ev += p; // dealer bust → +1
    else {
      const dt = parseInt(k, 10);
      if (pt > dt) ev += p;
      else if (pt < dt) ev -= p;
    }
  }
  return ev;
}

function evInitialBlackjack(upcard: Rank, rules: Rules, shoe: Shoe): number {
  const dist = dealerOutcomeProbs(upcard, shoe, rules);
  const pDealerBJ = dist["21"] || 0;
  const payout = rules.blackjackPays; // 1.5 (3:2) or 1.2 (6:5)
  return (1 - pDealerBJ) * payout;
}

function handKey(hand: Hand): string {
  const counts: Record<string, number> = {};
  for (const r of hand.map(normalizeRank)) counts[r] = (counts[r] || 0) + 1;
  return Object.entries(counts).sort().map(([r, c]) => `${r}x${c}`).join(",");
}

function bestActionEV(hand: Hand, ctx: PlayerContext, shoe: Shoe, cache: Map<string, number>): number {
  const t = handTotals(hand);
  const key = [
    handKey(hand),
    `pt=${t.best}${t.isSoft ? "S" : "H"}`,
    `up=${ctx.upcard}`,
    `cd=${ctx.canDouble ? 1 : 0}`,
    `cs=${ctx.canSplit ? 1 : 0}`,
    `sd=${ctx.splitDepth}`,
    `sa=${ctx.isSplitAces ? 1 : 0}`,
    `H17=${ctx.rules.dealerHitsSoft17 ? 1 : 0}`,
    `SR=${ctx.rules.lateSurrender ? 1 : 0}`,
    `shoe=${shoeKey(shoe)}`
  ].join("|");
  if (cache.has(key)) return cache.get(key)!;

  if (isBust(hand)) { cache.set(key, -1); return -1; }
  const initial = hand.length === 2 && ctx.splitDepth === 0;
  if (initial && isBlackjack(hand)) {
    const v = evInitialBlackjack(ctx.upcard, ctx.rules, shoe);
    cache.set(key, v);
    return v;
  }

  // Stand
  const standEV = evStand(hand, ctx.upcard, ctx.rules, shoe);

  // Hit
  let hitEV = 0;
  {
    const tot = shoeTotal(shoe);
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue;
      const p = shoe[r] / tot;
      draw(shoe, r);
      const next = [...hand, r];
      const v = (ctx.isSplitAces && ctx.rules.splitAcesOneCardOnly)
        ? evStand(next, ctx.upcard, ctx.rules, shoe)
        : bestActionEV(next, ctx, shoe, cache);
      undraw(shoe, r);
      hitEV += p * v;
    }
  }

  // Double
  let doubleEV = Number.NEGATIVE_INFINITY;
  if (ctx.canDouble && hand.length === 2 && ctx.rules.doubleAllowed) {
    let v2 = 0;
    const tot2 = shoeTotal(shoe);
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue;
      const p = shoe[r] / tot2;
      draw(shoe, r);
      v2 += p * evStand([...hand, r], ctx.upcard, ctx.rules, shoe);
      undraw(shoe, r);
    }
    doubleEV = 2 * v2; // normalized to initial bet
  }

  // Surrender
  const surrenderEV = (ctx.rules.lateSurrender && hand.length === 2 && ctx.splitDepth === 0) ? -0.5 : Number.NEGATIVE_INFINITY;

  // Split
  let splitEV = Number.NEGATIVE_INFINITY;
  if (ctx.canSplit && hand.length === 2 && (normalizeRank(hand[0]) === normalizeRank(hand[1]))) {
    const splittingAces = hand[0] === "A" && hand[1] === "A";
    const canResplit = ctx.splitDepth < ctx.rules.resplitPairs && (splittingAces ? ctx.rules.resplitAces : true);
    let left = 0, right = 0;
    const totS = shoeTotal(shoe);
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue;
      const p = shoe[r] / totS;
      draw(shoe, r);
      const childCtx: PlayerContext = {
        ...ctx,
        canDouble: ctx.doubleAfterSplit,
        canSplit: canResplit,
        splitDepth: ctx.splitDepth + 1,
        isSplitAces: splittingAces
      };
      const leftEV  = splittingAces && ctx.rules.splitAcesOneCardOnly
        ? evStand([hand[0], r], ctx.upcard, ctx.rules, shoe)
        : bestActionEV([hand[0], r], childCtx, shoe, cache);
      const rightEV = splittingAces && ctx.rules.splitAcesOneCardOnly
        ? evStand([hand[1], r], ctx.upcard, ctx.rules, shoe)
        : bestActionEV([hand[1], r], childCtx, shoe, cache);
      undraw(shoe, r);
      left  += p * leftEV;
      right += p * rightEV;
    }
    splitEV = left + right;
  }

  const best = Math.max(standEV, hitEV, doubleEV, surrenderEV, splitEV);
  cache.set(key, best);
  return best;
}

function actionEVsFinite(hand: Hand, ctx: PlayerContext, shoe: Shoe): { [action: string]: number } {
  const cache = new Map<string, number>();
  const res: Record<string, number> = {};

  // Stand
  res["Stand"] = evStand(hand, ctx.upcard, ctx.rules, shoe);

  // Hit
  let hitEV = 0;
  {
    const tot = shoeTotal(shoe);
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue;
      const p = shoe[r] / tot;
      draw(shoe, r);
      const v = (ctx.isSplitAces && ctx.rules.splitAcesOneCardOnly)
        ? evStand([...hand, r], ctx.upcard, ctx.rules, shoe)
        : bestActionEV([...hand, r], ctx, shoe, cache);
      undraw(shoe, r);
      hitEV += p * v;
    }
  }
  res["Hit"] = hitEV;

  // Double
  if (ctx.canDouble && hand.length === 2 && ctx.rules.doubleAllowed) {
    let v2 = 0;
    const tot2 = shoeTotal(shoe);
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue;
      const p = shoe[r] / tot2;
      draw(shoe, r);
      v2 += p * evStand([...hand, r], ctx.upcard, ctx.rules, shoe);
      undraw(shoe, r);
    }
    res["Double"] = 2 * v2;
  }

  // Surrender
  if (ctx.rules.lateSurrender && hand.length === 2 && ctx.splitDepth === 0) {
    res["Surrender"] = -0.5;
  }

  // Split
  if (hand.length === 2 && (normalizeRank(hand[0]) === normalizeRank(hand[1]))) {
    const splittingAces = hand[0] === "A" && hand[1] === "A";
    const canResplit = ctx.splitDepth < ctx.rules.resplitPairs && (splittingAces ? ctx.rules.resplitAces : true);
    let left = 0, right = 0;
    const totS = shoeTotal(shoe);
    for (const r of RANKS) {
      if (shoe[r] <= 0) continue;
      const p = shoe[r] / totS;
      draw(shoe, r);
      const childCtx: PlayerContext = {
        ...ctx,
        canDouble: ctx.doubleAfterSplit,
        canSplit: canResplit,
        splitDepth: ctx.splitDepth + 1,
        isSplitAces: splittingAces
      };
      const leftEV  = splittingAces && ctx.rules.splitAcesOneCardOnly
        ? evStand([hand[0], r], ctx.upcard, ctx.rules, shoe)
        : bestActionEV([hand[0], r], childCtx, shoe, cache);
      const rightEV = splittingAces && ctx.rules.splitAcesOneCardOnly
        ? evStand([hand[1], r], ctx.upcard, ctx.rules, shoe)
        : bestActionEV([hand[1], r], childCtx, shoe, cache);
      undraw(shoe, r);
      left  += p * leftEV;
      right += p * rightEV;
    }
    res["Split"] = left + right;
  }

  // Blackjack payout (2-card only)
  if (hand.length === 2 && isBlackjack(hand)) {
    res["Blackjack"] = evInitialBlackjack(ctx.upcard, ctx.rules, shoe);
  }

  return res;
}

/** ---------- Small UI pieces ---------- */
const CardPicker: React.FC<{ label: string; cards: Hand; setCards: (h: Hand) => void; maxCards?: number; }>
= ({ label, cards, setCards, maxCards = 2 }) => (
  <div className="flex flex-col gap-2">
    <div className="text-sm font-medium">{label}</div>
    <div className="flex gap-2 items-center flex-wrap">
      {cards.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <select
            className="border rounded-xl px-3 py-2 text-sm"
            value={c}
            onChange={e => {
              const next = [...cards];
              next[i] = e.target.value as Rank;
              setCards(next);
            }}
          >
            {RANKS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="text-xs text-gray-600 underline" onClick={() => setCards(cards.filter((_, idx) => idx !== i))}>remove</button>
        </div>
      ))}
      {cards.length < maxCards && (
        <button className="border rounded-xl px-3 py-2 text-sm" onClick={() => setCards([...cards, "A"])}>+ Add card</button>
      )}
    </div>
  </div>
);

const Toggle: React.FC<{label: string; checked: boolean; onChange: (v:boolean)=>void}>
= ({ label, checked, onChange }) => (
  <label className="flex items-center justify-between gap-4 py-2">
    <span className="text-sm">{label}</span>
    <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} />
  </label>
);

const NumberInput: React.FC<{label:string; value:number; onChange:(n:number)=>void; min?:number; max?:number}>
= ({label, value, onChange, min=0, max=10}) => (
  <label className="flex items-center justify-between gap-4 py-2">
    <span className="text-sm">{label}</span>
    <input
      type="number"
      className="border rounded px-2 py-1 w-20"
      value={value}
      min={min}
      max={max}
      step={1}
      onChange={e=>onChange(parseInt(e.target.value || "0", 10))}
    />
  </label>
);

/** ---------- Helpers ---------- */
function formatEV(ev: number | undefined): string {
  if (ev === undefined || !isFinite(ev)) return "—";
  return (ev >= 0 ? "+" : "") + ev.toFixed(4);
}
function bestMoveFrom(evs: Record<string, number>): { move: string; ev: number } {
  let bestM = "Stand"; let bestV = -Infinity;
  for (const [k, v] of Object.entries(evs)) { if (v > bestV) { bestV = v; bestM = k; } }
  return { move: bestM, ev: bestV };
}

/** ---------- App (multiple hands) ---------- */
export default function App() {
  const [hands, setHands] = useState<Hand[]>([
    ["A","7"],
  ]);
  const [dealerUp, setDealerUp] = useState<Rank>("6");
  const [rules, setRules] = useState<Rules>({ ...DEFAULT_RULES });

  // One finite shoe with ALL shown cards removed (every hand + dealer upcard)
  const baseShoe = useMemo(() => initShoeMulti(rules.decks, hands, dealerUp), [rules.decks, hands, dealerUp]);

  // Per-hand contexts & EVs
  const perHand = useMemo(() => {
    return hands.map((hand) => {
      const ctx: PlayerContext = {
        rules,
        upcard: dealerUp,
        canDouble: hand.length === 2,
        canSplit: canSplit(hand),
        splitDepth: 0,
        isSplitAces: false,
        doubleAfterSplit: rules.doubleAfterSplit,
      };
      const evs = actionEVsFinite(hand, ctx, baseShoe);
      const best = bestMoveFrom(evs);
      const totals = handTotals(hand);
      return { evs, best, totals, ctx };
    });
  }, [hands, rules, dealerUp, baseShoe]);

  const addHand = () => setHands([...hands, ["A","7"]]);
  const removeHand = (idx: number) => setHands(hands.filter((_, i) => i !== idx));
  const setHandAt = (idx: number, newHand: Hand) => {
    const next = [...hands]; next[idx] = newHand; setHands(next);
  };

  // Total EV across all hands (sum of each hand's best EV)
  const totalEV = perHand.reduce((s, h) => s + h.best.ev, 0);

  return (
    <div className="min-h-screen w-full bg-gray-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold mb-2">Blackjack EV Helper — Multiple Hands</h1>
        <p className="text-sm text-gray-700 mb-6">
          Evaluate several hands at once. EVs use a finite shoe with all shown cards removed.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Left: hands + per-hand results */}
          <div className="md:col-span-2 flex flex-col gap-6">
            {hands.map((hand, idx) => {
              const info = perHand[idx];
              return (
                <div key={idx} className="bg-white rounded-2xl shadow p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold">Hand {idx + 1}</h2>
                    <button
                      className="text-xs text-red-600 underline"
                      onClick={() => removeHand(idx)}
                      disabled={hands.length === 1}
                      title={hands.length === 1 ? "Keep at least one hand" : "Remove this hand"}
                    >
                      remove hand
                    </button>
                  </div>

                  <div className="mt-3">
                    <CardPicker
                      label="Player Cards"
                      cards={hand}
                      setCards={(h) => setHandAt(idx, h)}
                      maxCards={10}
                    />
                    <div className="mt-3 text-xs text-gray-600">
                      Total: <b>{info.totals.best}</b> {info.totals.isSoft ? "(soft)" : "(hard)"} {isBlackjack(hand) && <span className="ml-1">• Blackjack</span>}
                    </div>
                    <div className="mt-3 text-xs text-gray-600">Pair: {canSplit(hand) ? <b>Yes</b> : "No"}</div>
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium">Best Move</div>
                      <div className="text-sm">
                        <span className="font-semibold">{info.best.move}</span>
                        <span className="ml-2">EV: <span className={info.best.ev>=0?"text-green-600":"text-red-600"}>{formatEV(info.best.ev)}</span></span>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left border-b"><th className="py-2 pr-4">Action</th><th className="py-2">EV</th></tr>
                        </thead>
                        <tbody>
                          {Object.entries(info.evs).sort((a,b)=>b[1]-a[1]).map(([k,v])=> (
                            <tr key={k} className="border-b last:border-b-0">
                              <td className="py-2 pr-4">{k}</td>
                              <td className="py-2 font-mono">{formatEV(v)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })}

            <button className="border rounded-xl px-3 py-2 text-sm bg-white shadow" onClick={addHand}>
              + Add another hand
            </button>
          </div>

          {/* Right: dealer + rules + aggregate */}
          <div className="bg-white rounded-2xl shadow p-4 h-fit">
            <div className="mb-4">
              <div className="text-sm font-medium mb-2">Dealer Upcard</div>
              <select
                className="border rounded-xl px-3 py-2 text-sm"
                value={dealerUp}
                onChange={e=>setDealerUp(e.target.value as Rank)}
              >
                {RANKS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>

            <h3 className="text-base font-semibold mb-2">Rules</h3>
            <label className="flex items-center justify-between gap-4 py-2">
              <span className="text-sm">Decks</span>
              <select
                className="border rounded px-2 py-1"
                value={rules.decks}
                onChange={e=>setRules({ ...rules, decks: parseInt(e.target.value,10) as number })}
              >
                {[1,2,3,4,5,6,7,8].map(n=> <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <Toggle label="Dealer hits soft 17 (H17)" checked={rules.dealerHitsSoft17} onChange={v=>setRules({ ...rules, dealerHitsSoft17: v })} />
            <Toggle label="Late surrender" checked={rules.lateSurrender} onChange={v=>setRules({ ...rules, lateSurrender: v })} />
            <Toggle label="Double on any 2 cards" checked={rules.doubleAllowed} onChange={v=>setRules({ ...rules, doubleAllowed: v })} />
            <Toggle label="Double after split (DAS)" checked={rules.doubleAfterSplit} onChange={v=>setRules({ ...rules, doubleAfterSplit: v })} />
            <NumberInput label="Resplit pairs (times)" value={rules.resplitPairs} min={0} max={6} onChange={n=>setRules({ ...rules, resplitPairs: n })} />
            <Toggle label="Split Aces: one card only" checked={rules.splitAcesOneCardOnly} onChange={v=>setRules({ ...rules, splitAcesOneCardOnly: v })} />
            <Toggle label="Allow resplit Aces" checked={rules.resplitAces} onChange={v=>setRules({ ...rules, resplitAces: v })} />

            <div className="mt-4 p-3 rounded-lg bg-gray-50 text-sm">
              <div className="font-medium mb-1">Summary</div>
              <div>Hands: {hands.length}</div>
              <div>Sum of all EVs: <span className={totalEV>=0?"text-green-600":"text-red-600"}>{formatEV(totalEV)}</span></div>
            </div>
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-gray-500">
          © {new Date().getFullYear()} Blackjack EV Helper • Finite deck engine, multi-hand.
        </div>
      </div>
    </div>
  );
}
