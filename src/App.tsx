import React, { useEffect, useMemo, useState } from "react";
import {
  Action, ActionEVs, Card, CARDS, DECKS, Decks, Rules, Table, UPCARDS,
  actionEVs, bestAction, gameEV, handTotal, indexVariant, loadVariant, playerKey,
  startingHands, statedGameEV, variantCode,
} from "./woo";

type Hand = { a: Card; b: Card; bet: number };

const DEFAULT_RULES: Rules = { decks: 6, h17: true, das: true, surrender: true, bjPays: 1.5 };
const STORAGE_KEY = "blackjack_ev:v3";

function loadSaved(): { rules: Rules; hands: Hand[]; up: Card } {
  const fallback = { rules: DEFAULT_RULES, hands: [{ a: "A" as Card, b: "7" as Card, bet: 1 }], up: "6" as Card };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw);
    const okCard = (c: unknown): c is Card => CARDS.includes(c as Card);
    const hands = Array.isArray(s.hands)
      ? s.hands.filter((h: any) => okCard(h?.a) && okCard(h?.b)).map((h: any) => ({ a: h.a, b: h.b, bet: Number(h.bet) > 0 ? Number(h.bet) : 1 }))
      : [];
    const rules = { ...DEFAULT_RULES, ...s.rules };
    if (!DECKS.includes(rules.decks)) rules.decks = DEFAULT_RULES.decks;
    return { rules, hands: hands.length ? hands : fallback.hands, up: okCard(s.up) ? s.up : fallback.up };
  } catch {
    return fallback;
  }
}

const ACTION_SHORT: Record<Action, string> = { Blackjack: "BJ", Stand: "S", Hit: "H", Double: "D", Split: "P", Surrender: "R" };

function fmt(ev: number | undefined, digits = 4): string {
  if (ev === undefined || !Number.isFinite(ev)) return "—";
  return (ev >= 0 ? "+" : "") + ev.toFixed(digits);
}
const pct = (ev: number) => (ev >= 0 ? "+" : "") + (ev * 100).toFixed(3) + "%";
const sign = (ev: number) => (ev > 0 ? "pos" : ev < 0 ? "neg" : "");

/** ---------- Small UI pieces ---------- */
const CardRow: React.FC<{ label: string; value: Card; onChange: (c: Card) => void; order?: Card[] }> =
  ({ label, value, onChange, order = CARDS }) => (
    <div className="card-row" role="group" aria-label={label}>
      <span className="card-row-label">{label}</span>
      <div className="chips">
        {order.map(c => (
          <button key={c} className={"chip" + (c === value ? " on" : "")} aria-pressed={c === value} onClick={() => onChange(c)}>{c}</button>
        ))}
      </div>
    </div>
  );

const Segmented = <T extends string | number>({ label, value, options, onChange }:
  { label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) => (
  <div className="field">
    <span>{label}</span>
    <div className="seg">
      {options.map(o => (
        <button key={String(o.v)} className={o.v === value ? "on" : ""} aria-pressed={o.v === value} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  </div>
);

const ACTION_ORDER: Action[] = ["Blackjack", "Stand", "Hit", "Double", "Split", "Surrender"];

const EVTable: React.FC<{ evs: ActionEVs; bet: number }> = ({ evs, bet }) => {
  const best = bestAction(evs);
  const rows = ACTION_ORDER.filter(a => evs[a] !== undefined).map(a => [a, evs[a]!] as const);
  return (
    <table className="ev-table">
      <thead><tr><th>Action</th><th>EV / unit</th><th>Cost vs best</th>{bet !== 1 && <th>EV × bet</th>}</tr></thead>
      <tbody>
        {rows.map(([a, v]) => (
          <tr key={a} className={a === best.action ? "best" : ""}>
            <td>{a}{a === best.action && <span className="tag">best</span>}</td>
            <td className={"num " + sign(v)}>{fmt(v)}</td>
            <td className="num muted">{a === best.action ? "" : fmt(v - best.ev)}</td>
            {bet !== 1 && <td className={"num " + sign(v)}>{fmt(v * bet, 3)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** ---------- App ---------- */
export default function App() {
  const saved = useMemo(loadSaved, []);
  const [rules, setRules] = useState<Rules>(saved.rules);
  const [hands, setHands] = useState<Hand[]>(saved.hands);
  const [up, setUp] = useState<Card>(saved.up);
  const [table, setTable] = useState<Table | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(false);

  const code = variantCode(rules);
  useEffect(() => {
    let live = true;
    setLoadError(null);
    loadVariant(code).then(v => { if (live) setTable(indexVariant(v)); })
      .catch(e => { if (live) { setTable(null); setLoadError(String(e?.message || e)); } });
    return () => { live = false; };
  }, [code]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ rules, hands, up })); } catch { /* storage unavailable */ }
  }, [rules, hands, up]);

  const ready = table && table.variant.code === code ? table : null;
  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => setRules(r => ({ ...r, [k]: v }));
  const setHand = (i: number, h: Partial<Hand>) => setHands(hs => hs.map((x, j) => (j === i ? { ...x, ...h } : x)));

  const perHand = useMemo(() => hands.map(h => {
    const row = ready?.byKey.get(`${up}|${playerKey(h.a, h.b)}`);
    const evs = row ? actionEVs(row, rules) : null;
    return { evs, best: evs ? bestAction(evs) : null };
  }), [hands, up, rules, ready]);

  const totalBet = hands.reduce((s, h) => s + h.bet, 0);
  const totalEV = perHand.reduce((s, p, i) => s + (p.best ? p.best.ev * hands[i].bet : 0), 0);
  const houseEV = ready ? gameEV(ready, rules) : null;
  const stated = ready ? statedGameEV(ready, rules) : null;
  const peeks = up === "A" || up === "10";

  return (
    <div className="page">
      <header>
        <h1>Blackjack EV Helper</h1>
        <p className="muted">Exact two-card expected values from the Wizard of Odds Appendix 9 tables.</p>
      </header>

      <div className="layout">
        <main>
          <section className="panel">
            <CardRow label="Dealer upcard" value={up} onChange={setUp} order={UPCARDS} />
            {peeks && <p className="note">Dealer shows {up === "A" ? "an ace" : "a ten"}: EVs below assume the dealer has already checked and does not have blackjack.</p>}
          </section>

          {hands.map((h, i) => {
            const t = handTotal(h.a, h.b);
            const { evs, best } = perHand[i];
            return (
              <section className="panel" key={i}>
                <div className="panel-head">
                  <h2>Hand {i + 1}</h2>
                  <div className="hand-meta">
                    <span className="muted">{h.a === h.b ? "Pair" : t.soft ? "Soft" : "Hard"} {t.total}{h.a !== h.b && t.total === 21 && t.soft ? " · Blackjack" : ""}</span>
                    <label className="bet">Bet <input type="number" min={0.01} step={1} value={h.bet}
                      onChange={e => setHand(i, { bet: Math.max(0.01, Number(e.target.value) || 1) })} /></label>
                    <button className="link" disabled={hands.length === 1} onClick={() => setHands(hs => hs.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                </div>
                <CardRow label="Card 1" value={h.a} onChange={c => setHand(i, { a: c })} />
                <CardRow label="Card 2" value={h.b} onChange={c => setHand(i, { b: c })} />
                {evs && best ? (
                  <>
                    <div className="verdict"><span className="verdict-move">{best.action}</span><span className={"verdict-ev " + sign(best.ev)}>{fmt(best.ev)}</span></div>
                    <EVTable evs={evs} bet={h.bet} />
                  </>
                ) : <p className="muted">{loadError ?? "Loading table…"}</p>}
              </section>
            );
          })}
          <button className="add" onClick={() => setHands(hs => [...hs, { a: "10", b: "6", bet: 1 }])}>+ Add another hand</button>
        </main>

        <aside>
          <section className="panel">
            <h2>Rules</h2>
            <div className="field">
              <span>Decks</span>
              <div className="seg">
                {DECKS.map(d => <button key={d} className={d === rules.decks ? "on" : ""} aria-pressed={d === rules.decks} onClick={() => set("decks", d as Decks)}>{d}</button>)}
              </div>
            </div>
            <Segmented label="Soft 17" value={rules.h17 ? "h" : "s"} options={[{ v: "h", label: "Hits" }, { v: "s", label: "Stands" }]} onChange={v => set("h17", v === "h")} />
            <Segmented label="Double after split" value={rules.das ? 1 : 0} options={[{ v: 1, label: "Yes" }, { v: 0, label: "No" }]} onChange={v => set("das", v === 1)} />
            <Segmented label="Late surrender" value={rules.surrender ? 1 : 0} options={[{ v: 1, label: "Yes" }, { v: 0, label: "No" }]} onChange={v => set("surrender", v === 1)} />
            <Segmented label="Blackjack pays" value={rules.bjPays} options={[{ v: 1.5, label: "3:2" }, { v: 1.2, label: "6:5" }]} onChange={v => set("bjPays", v)} />
            <p className="fine">Fixed by the tables: double on any two cards, resplit to 4 hands (not aces), one card to split aces.</p>
          </section>

          <section className="panel">
            <h2>Summary</h2>
            <dl className="stats">
              <dt>Hands</dt><dd>{hands.length}</dd>
              <dt>Total bet</dt><dd>{+totalBet.toFixed(2)}</dd>
              <dt>Total EV (sum)</dt><dd className={sign(totalEV)}>{fmt(totalEV)}</dd>
              <dt>EV per unit bet</dt><dd className={sign(totalEV)}>{fmt(totalBet ? totalEV / totalBet : 0)}</dd>
            </dl>
            <p className="fine">The sum is your expected profit for the round, in bet units. EV per unit bet is that sum divided by the total bet, a weighted average across your hands. With one hand at bet 1 they are the same.</p>
          </section>

          <section className="panel">
            <h2>Game EV for these rules</h2>
            {houseEV !== null ? (
              <>
                <div className={"big " + sign(houseEV)}>{pct(houseEV)}</div>
                <p className="fine">The sum, over every possible starting hand and upcard, of probability × EV of the best play, plus the rounds where the dealer has blackjack.
                  {stated !== null && <> Wizard of Odds lists {pct(stated)} for these rules{Math.abs(stated - houseEV) < 1e-5 ? " ✓" : ""}.</>}
                </p>
              </>
            ) : <p className="muted">{loadError ?? "Loading…"}</p>}
          </section>
        </aside>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Strategy chart · {rules.decks} deck{rules.decks > 1 ? "s" : ""}, {rules.h17 ? "H17" : "S17"}</h2>
          <button className="link" onClick={() => setShowChart(!showChart)}>{showChart ? "Hide" : "Show"}</button>
        </div>
        {showChart && ready && <StrategyChart table={ready} rules={rules} onPick={(a, b, u) => { setHand(0, { a, b }); setUp(u); window.scrollTo({ top: 0, behavior: "smooth" }); }} />}
      </section>

      <footer className="fine">
        Data: <a href={ready?.variant.source ?? "https://wizardofodds.com/games/blackjack/appendix/9/"} target="_blank" rel="noreferrer">Wizard of Odds, Blackjack Appendix 9</a>.
        Tables assume a full shoe, so the cards in your other hands are not removed from it.
      </footer>
    </div>
  );
}

const StrategyChart: React.FC<{ table: Table; rules: Rules; onPick: (a: Card, b: Card, up: Card) => void }> = ({ table, rules, onPick }) => {
  const hands = useMemo(startingHands, []);
  return (
    <>
      <p className="fine legend">
        {(["Hit", "Stand", "Double", "Split", "Surrender"] as Action[]).map(a => <span key={a}><b className={"cell a-" + ACTION_SHORT[a]}>{ACTION_SHORT[a]}</b> {a}</span>)}
        <span>Click a cell to load it into Hand 1.</span>
      </p>
      <div className="chart-wrap">
        <table className="chart">
          <thead><tr><th>Hand</th>{UPCARDS.map(u => <th key={u}>{u}</th>)}</tr></thead>
          <tbody>
            {hands.map(({ group, a, b }, i) => {
              const t = handTotal(a, b);
              const groupStart = i === 0 || hands[i - 1].group !== group;
              return (
                <React.Fragment key={a + b}>
                  {groupStart && <tr className="group"><th colSpan={UPCARDS.length + 1}>{group}</th></tr>}
                  <tr>
                    <th>{group === "Soft" ? `A,${a}` : `${a},${b}`} <span className="muted">{group === "Pairs" ? "" : t.total}</span></th>
                    {UPCARDS.map(u => {
                      const row = table.byKey.get(`${u}|${playerKey(a, b)}`);
                      if (!row) return <td key={u}>?</td>;
                      const best = bestAction(actionEVs(row, rules));
                      const s = ACTION_SHORT[best.action];
                      return (
                        <td key={u}>
                          <button className={"cell a-" + s} title={`${a},${b} vs ${u}: ${best.action} ${fmt(best.ev)}`} onClick={() => onPick(a, b, u)}>{s}</button>
                        </td>
                      );
                    })}
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};
