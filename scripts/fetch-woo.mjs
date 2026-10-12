// Downloads every Wizard of Odds Appendix 9 rule set and writes it to src/data/woo/<code>.json.
// Run with: npm run fetch-data
// Each file is checked against the "Expected return of game" figures printed on the page;
// the script fails (and writes nothing for that variant) if our weighted sum disagrees.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://wizardofodds.com/games/blackjack/appendix/9/'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'woo')
const DECKS = [1, 2, 4, 5, 6, 8]
const TOL = 1e-5

const strip = s => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()

function parseTables(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || []
  return tables.map(tb =>
    (tb.match(/<tr[\s\S]*?<\/tr>/g) || []).map(tr =>
      (tr.match(/<t[hd][\s\S]*?<\/t[hd]>/g) || []).map(strip)))
}

function stated(html, das) {
  const label = das ? 'Player may double after split:' : 'Player may not double after split:'
  const m = strip(html).match(new RegExp(label.replace(/ /g, '\\s+') + '\\s*(-?[0-9.]+)'))
  if (!m) throw new Error(`could not find "${label}"`)
  return Number(m[1])
}

async function fetchVariant(code) {
  const res = await fetch(BASE + code + '/', { headers: { 'User-Agent': 'Mozilla/5.0 (blackjack_ev data fetch)' } })
  if (!res.ok) throw new Error(`${code}: HTTP ${res.status}`)
  const html = await res.text()
  const [nonPairs, pairs, dealerBJ] = parseTables(html)
  if (!nonPairs || !pairs || !dealerBJ) throw new Error(`${code}: expected 3 tables`)
  if (nonPairs[0].join('|') !== 'Dealer|Player|Stand|Hit|Double|Probability')
    throw new Error(`${code}: unexpected header ${nonPairs[0].join('|')}`)
  if (!/^Dealer\|Player\|Stand\|Hit\|Double\|Split[\s\S]*No[\s\S]*\|Split[\s\S]*Yes[\s\S]*\|Probability$/.test(pairs[0].join('|')))
    throw new Error(`${code}: unexpected pair header ${pairs[0].join('|')}`)

  // WoO has the odd typo like "--0.453428" (6dh17r4, A vs 10,10); fix it loudly. The EV self-check below still guards the result.
  const num = (s, where) => {
    if (/^--\d/.test(s)) { console.warn(`  ${code} ${where}: fixed "${s}" on source page`); s = s.slice(1) }
    return Number(s)
  }
  // Row: [upcard, player, stand, hit, double, splitNoDAS, splitDAS, probability]; split is null for non-pairs.
  const rows = []
  for (const r of nonPairs.slice(1)) rows.push([r[0], r[1], ...r.slice(2, 5).map(s => num(s, `${r[0]} ${r[1]}`)), null, null, num(r[5], `${r[0]} ${r[1]}`)])
  for (const r of pairs.slice(1)) rows.push([r[0], r[1], ...r.slice(2, 8).map(s => num(s, `${r[0]} ${r[1]}`))])
  for (const r of rows) if (r.slice(2).some(v => v !== null && !Number.isFinite(v))) throw new Error(`${code}: bad number in ${r}`)

  // Some pages have [Player, Stand, Probability], others [Player, Stand, Hit, Double, Probability].
  const bj = Object.fromEntries(dealerBJ.slice(1).map(r => [r[0], { ev: +r[1], p: +r[r.length - 1] }]))
  if (!bj['BJ'] || !bj['Non BJ']) throw new Error(`${code}: dealer blackjack table missing`)

  const data = {
    code,
    source: BASE + code + '/',
    rows,
    dealerBJ: { pushProb: bj['BJ'].p, loseProb: bj['Non BJ'].p },
    statedEV: { das: stated(html, true), noDas: stated(html, false) },
  }

  // Self-check: game EV = sum over all starting hands of probability * best EV.
  for (const das of [true, false]) {
    let ev = -data.dealerBJ.loseProb, p = data.dealerBJ.pushProb + data.dealerBJ.loseProb
    for (const [, , s, h, d, sn, sd, prob] of rows) {
      const split = das ? sd : sn
      ev += prob * Math.max(s, h, d, split ?? -Infinity)
      p += prob
    }
    const want = das ? data.statedEV.das : data.statedEV.noDas
    if (Math.abs(ev - want) > TOL || Math.abs(p - 1) > 1e-4)
      throw new Error(`${code}: check failed (das=${das}) computed ${ev.toFixed(6)} vs stated ${want}, total prob ${p}`)
  }
  return data
}

await mkdir(OUT, { recursive: true })
for (const d of DECKS) for (const h of ['h17', 's17']) {
  const code = `${d}d${h}r4`
  const data = await fetchVariant(code)
  await writeFile(join(OUT, code + '.json'), JSON.stringify(data))
  console.log(`${code}: ${data.rows.length} hands, game EV ${data.statedEV.das} (DAS) / ${data.statedEV.noDas} (no DAS) ✓`)
}
