/** Wizard of Odds Appendix 9 tables: loading, lookup and EV math. Data comes from scripts/fetch-woo.mjs. */

export type Card = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10";
export const CARDS: Card[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
export const UPCARDS: Card[] = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "A"];

export const DECKS = [1, 2, 4, 5, 6, 8] as const;
export type Decks = (typeof DECKS)[number];

export type Rules = {
  decks: Decks;
  h17: boolean;        // dealer hits soft 17
  das: boolean;        // double after split
  surrender: boolean;  // late surrender
  bjPays: 1.5 | 1.2;   // 3:2 or 6:5
};

// [upcard, player, stand, hit, double, splitNoDAS, splitDAS, probability]; split is null for non-pairs.
export type Row = [string, string, number, number, number, number | null, number | null, number];

export type Variant = {
  code: string;
  source: string;
  rows: Row[];
  dealerBJ: { pushProb: number; loseProb: number };
  statedEV: { das: number; noDas: number };
};

export type Action = "Blackjack" | "Stand" | "Hit" | "Double" | "Split" | "Surrender";
export type ActionEVs = Partial<Record<Action, number>>;

export const variantCode = (r: Rules) => `${r.decks}d${r.h17 ? "h" : "s"}17r4`;

// Each rule set is its own chunk, so the page only downloads the table it needs.
const loaders = import.meta.glob<Variant>("./data/woo/*.json", { import: "default" });

export async function loadVariant(code: string): Promise<Variant> {
  const load = loaders[`./data/woo/${code}.json`];
  if (!load) throw new Error(`No Wizard of Odds table for ${code}`);
  return load();
}

export type Table = { variant: Variant; byKey: Map<string, Row> };

export function indexVariant(variant: Variant): Table {
  return { variant, byKey: new Map(variant.rows.map(r => [`${r[0]}|${r[1]}`, r])) };
}

const value = (c: Card) => (c === "A" ? 1 : Number(c));

/** WoO writes the higher card first with aces low: "10,A", "3,2", "A,A". */
export function playerKey(a: Card, b: Card): string {
  return value(a) >= value(b) ? `${a},${b}` : `${b},${a}`;
}

export function handTotal(a: Card, b: Card): { total: number; soft: boolean } {
  const hard = value(a) + value(b);
  const soft = (a === "A" || b === "A") && hard + 10 <= 21;
  return { total: soft ? hard + 10 : hard, soft };
}

/**
 * EV per unit of original bet for each legal action. For a dealer A or 10 these are
 * conditional on the dealer not having blackjack (the dealer peeks first), as in the WoO tables.
 */
export function actionEVs(row: Row, rules: Rules): ActionEVs {
  const [, player, stand, hit, double, splitNoDas, splitDas] = row;
  if (player === "10,A") return { Blackjack: rules.bjPays };
  const out: ActionEVs = { Stand: stand, Hit: hit, Double: double };
  const split = rules.das ? splitDas : splitNoDas;
  if (split !== null) out.Split = split;
  if (rules.surrender) out.Surrender = -0.5;
  return out;
}

export function bestAction(evs: ActionEVs): { action: Action; ev: number } {
  let action: Action = "Stand", ev = -Infinity;
  for (const [a, v] of Object.entries(evs) as [Action, number][]) if (v > ev) { action = a; ev = v; }
  return { action, ev };
}

/**
 * Expected return of the whole game: sum over every starting hand of P(hand) * EV(best play),
 * plus the dealer-blackjack rounds (push against a player blackjack, lose one unit otherwise).
 * The probabilities add to 1, so this sum is the probability-weighted average EV per round.
 */
export function gameEV(table: Table, rules: Rules): number {
  let ev = -table.variant.dealerBJ.loseProb;
  for (const row of table.variant.rows) ev += row[7] * bestAction(actionEVs(row, rules)).ev;
  return ev;
}

/** The figure WoO prints for these rules, when the rules are ones their page covers. */
export function statedGameEV(table: Table, rules: Rules): number | null {
  if (rules.surrender || rules.bjPays !== 1.5) return null;
  return rules.das ? table.variant.statedEV.das : table.variant.statedEV.noDas;
}

/** Every distinct two-card starting hand, grouped the way strategy charts are. */
export function startingHands(): { group: "Hard" | "Soft" | "Pairs"; a: Card; b: Card }[] {
  const out: { group: "Hard" | "Soft" | "Pairs"; a: Card; b: Card }[] = [];
  const nums = CARDS.slice(1); // 2..10
  const hard: [Card, Card][] = [];
  for (let i = 0; i < nums.length; i++) for (let j = 0; j < i; j++) hard.push([nums[i], nums[j]]);
  hard.sort((x, y) => handTotal(...x).total - handTotal(...y).total || value(y[0]) - value(x[0]));
  for (const [a, b] of hard) out.push({ group: "Hard", a, b });
  for (const c of nums) out.push({ group: "Soft", a: c, b: "A" });
  for (const c of nums) out.push({ group: "Pairs", a: c, b: c });
  out.push({ group: "Pairs", a: "A", b: "A" });
  return out;
}
