/**
 * Programul cultural al Timișoarei (src/data/events.json): spectacole, concerte, filme de artă și
 * expoziții, din site-urile oficiale ale instituțiilor. Refăcut zilnic de .github/workflows/events.yml.
 *
 *   npx tsx scripts/build-events.ts <ieșire.json>
 *
 * Fiecare sursă e separată: dacă un site își schimbă pagina, doar programul lui lipsește (și apare un
 * avertisment în GitHub), restul merge mai departe. Respectăm robots.txt și cerem fiecare pagină o dată.
 *
 * Fiecare eveniment:
 *   v loc (cheia din VENUES) · t titlu · s început, ora Timișoarei „2026-11-08T18:00” (fără oră: doar data;
 *   lipsă: expoziție în desfășurare) · k fel (opera | theatre | concert | kids | film | exhibition | tour)
 *   · u pagina evenimentului · b bilete · x notă scurtă (sala, limba, „bilete epuizate”) · a autor/serie
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';

type Kind = 'opera' | 'theatre' | 'concert' | 'kids' | 'film' | 'exhibition' | 'tour';
export interface Ev { v: string; t: string; s?: string; k: Kind; u?: string; b?: string; x?: string; a?: string }

/** Locurile: numele afișat, coordonatele și un model după care le găsim printre locurile din ghid. */
export const VENUES: Record<string, { n: string; la: number; lo: number; match: string; web: string; r?: number }> = {
  opera: { n: 'Opera Națională Română', la: 45.7541, lo: 21.22594, match: '^opera|oper[aă] (na[țţt]ional|rom[aâ]n)', web: 'https://www.ort.ro/ro/Spectacole.html' },
  tnt: { n: 'Teatrul Național „Mihai Eminescu”', la: 45.75435, lo: 21.22601, match: 'teatrul na[țţt]ional', web: 'https://www.tntm.ro/' },
  german: { n: 'Teatrul German de Stat', la: 45.75438, lo: 21.22638, match: 'german', web: 'https://teatrulgerman.ro/ro/program/' },
  csiky: { n: 'Teatrul Maghiar „Csiky Gergely”', la: 45.75442, lo: 21.2264, match: 'maghiar|csiky', web: 'https://tm-t.ro/programme' },
  merlin: { n: 'Teatrul Merlin', la: 45.7458, lo: 21.21437, match: 'merlin', web: 'https://www.teatrul-merlin.ro/' },
  fila: { n: 'Filarmonica Banatul', la: 45.75055, lo: 21.22627, match: 'filarmonica', web: 'https://filarmonicabanatul.ro/evenimente/' },
  // Doar legătura „Programul” (site-urile nu pot fi citite automat — vezi mai jos).
  mnart: { n: 'Muzeul Național de Artă', la: 45.75735, lo: 21.22929, match: 'muzeul de art', web: 'https://www.muzeuldeartatm.ro/' },
  mnab: { n: 'Muzeul Național al Banatului', la: 45.75706, lo: 21.23258, match: 'muzeul na[țţt]ional al banatului', web: 'https://mnab.ro/exhibition/' },
  ctimis: { n: 'Cinema Timiș', la: 45.75152, lo: 21.22551, match: 'cinema timi', web: 'https://cinema-timisoara.ro/' },
  cstudio: { n: 'Cinema Studio', la: 45.75235, lo: 21.22601, match: 'cinema studio', web: 'https://cinema-timisoara.ro/' },
  cvictoria: { n: 'Cinema Victoria', la: 45.74131, lo: 21.22453, match: 'cinema victoria', web: 'https://cinema-timisoara.ro/' },
  cjohnny: { n: 'Cinema Johnny', la: 45.73326, lo: 21.19088, match: 'cinema johnny', web: 'https://cinema-timisoara.ro/' },
  ccity: { n: 'Cinema City', la: 45.76646, lo: 21.22721, match: 'cinema city', web: 'https://www.cinemacity.ro/', r: 15000 },
};

const UA = 'timiGO/1.0 (ghidul orasului Timisoara; +https://github.com/dclaici)';
const TZ = 'Europe/Bucharest';
const now = new Date();
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(now); // 2026-11-08
const HORIZON_DAYS = 45;
const horizon = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(now.getTime() + HORIZON_DAYS * 864e5));

/* --------------------------------- Utilitare --------------------------------- */

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', bdquo: '„', rdquo: '”', ldquo: '“', lsquo: '‘', rsquo: '’', hellip: '…', icirc: 'î', Icirc: 'Î', acirc: 'â', Acirc: 'Â', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ouml: 'ö', uuml: 'ü', auml: 'ä', Aacute: 'Á', Eacute: 'É', odblac: 'ő', udblac: 'ű', raquo: '»', laquo: '«' };
const decode = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? m);
const text = (h: string) => decode(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const abs = (base: string, h?: string) => { if (!h) return undefined; try { return new URL(decode(h), base).href; } catch { return undefined; } };
const pad = (n: number | string) => String(n).padStart(2, '0');
const MONTHS: Record<string, number> = {
  ian: 1, ianuarie: 1, feb: 2, februarie: 2, mar: 3, martie: 3, apr: 4, aprilie: 4, mai: 5, iun: 6, iunie: 6, iul: 7, iulie: 7,
  aug: 8, august: 8, sep: 9, sept: 9, septembrie: 9, oct: 10, octombrie: 10, noi: 11, nov: 11, noiembrie: 11, dec: 12, decembrie: 12,
};
const month = (s: string) => MONTHS[s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')];
/** Anul pentru o zi-lună fără an: dacă luna a trecut de mult, e anul viitor. */
const yearFor = (m: number) => { const [y, cm] = today.split('-').map(Number); return m < cm - 2 ? y + 1 : y; };
/** O dată UTC („20261108T170000Z”) în ora Timișoarei „2026-11-08T19:00”. */
const fromUtc = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const cap = (s: string) => (s === s.toUpperCase() && /[A-ZĂÂÎȘȚ]{4}/.test(s) ? s.toLowerCase().replace(/(^|[\s/(„"-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s);

/** Ce am primit (pentru diagnostic când o sursă nu dă nimic). */
const lastFetch: string[] = [];
const robotsCache = new Map<string, string[]>();
async function allowed(u: string): Promise<boolean> {
  const { origin, pathname } = new URL(u);
  if (!robotsCache.has(origin)) {
    const dis: string[] = [];
    try {
      const r = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        let applies = false;
        for (const line of (await r.text()).split('\n')) {
          const [k, ...rest] = line.split(':'); const v = rest.join(':').trim(); const key = k.trim().toLowerCase();
          if (key === 'user-agent') applies = v === '*' || /timigo/i.test(v);
          else if (applies && key === 'disallow' && v) dis.push(v);
        }
      }
    } catch { /* fără robots.txt */ }
    robotsCache.set(origin, dis);
  }
  return !robotsCache.get(origin)!.some((d) => pathname.startsWith(d.replace(/\*.*$/, '')));
}

async function get(u: string, extraCa?: string): Promise<string> {
  if (!(await allowed(u))) throw new Error(`robots.txt nu permite ${u}`);
  if (extraCa) {
    return new Promise((res, rej) => https.get(u, { headers: { 'User-Agent': UA }, ca: [...tls.rootCertificates, extraCa], timeout: 30000 }, (r) => {
      if ((r.statusCode ?? 0) >= 400) { rej(new Error(`${u}: ${r.statusCode}`)); r.resume(); return; }
      let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c)); r.on('end', () => res(d));
    }).on('error', rej));
  }
  // Câte o încercare în plus: site-urile mici mai cad (sau ne refuză) pentru câteva secunde.
  let r: Response | undefined;
  for (let i = 0; i < 3; i++) {
    try {
      r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'ro-RO,ro;q=0.9' }, signal: AbortSignal.timeout(30000) });
      if (r.ok) break;
    } catch (e) { if (i === 2) throw e; }
    await new Promise((res) => setTimeout(res, 4000 * (i + 1)));
  }
  if (!r?.ok) throw new Error(`${u}: ${r?.status}`);
  const body = await r.text();
  lastFetch.push(`${u} → ${r.status} ${r.headers.get('content-type')} ${body.length}b: ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
  return body;
}

/**
 * Site-urile cu lanțul de certificate incomplet (ort.ro): luăm certificatul intermediar de la adresa
 * indicată chiar de certificatul serverului (AIA) și verificăm conexiunea normal, cu el adăugat.
 */
async function intermediate(host: string): Promise<string> {
  const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false });
  await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
  const aia = sock.getPeerCertificate(true).infoAccess?.['CA Issuers - URI']?.[0];
  sock.end();
  if (!aia) throw new Error(`${host}: fără AIA`);
  const der = Buffer.from(await (await fetch(aia, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
  return new X509Certificate(der).toString();
}

/* ---------------------------------- Surse ---------------------------------- */

/** Filarmonica Banatul — WordPress „The Events Calendar”, interfața JSON. */
async function filarmonica(): Promise<Ev[]> {
  const out: Ev[] = [];
  let url: string | undefined = `https://filarmonicabanatul.ro/wp-json/tribe/events/v1/events?per_page=50&start_date=${today}&end_date=${horizon}`;
  for (let page = 0; url && page < 4; page++) {
    const j = JSON.parse(await get(url));
    for (const e of j.events ?? []) {
      const t = text(e.title ?? '');
      const parts = t.split(/\s*\|\s*/);
      out.push({
        v: 'fila', t: parts[0], a: parts.slice(1, 3).join(' · ') || undefined, s: String(e.start_date).slice(0, 16).replace(' ', 'T'),
        k: /copii|educativ|kids|ani\)/i.test(t) ? 'kids' : 'concert', u: e.url, b: e.website || undefined,
        x: e.venue?.venue && !/capitol/i.test(e.venue.venue) ? text(e.venue.venue) : undefined,
      });
    }
    url = j.next_rest_url;
  }
  return out;
}

/** Teatrul Național — calendarul iCal al site-ului (Events Manager). */
async function tnt(): Promise<Ev[]> {
  const ics = (await get('https://www.tntm.ro/events.ics')).replace(/\r?\n[ \t]/g, '');
  const out: Ev[] = [];
  for (const block of ics.split('BEGIN:VEVENT').slice(1)) {
    const f = (k: string) => new RegExp(`^${k}(?:;[^:]*)?:(.*)$`, 'm').exec(block)?.[1]?.replace(/\\([,;\\])/g, '$1').replace(/\\n/g, '\n');
    const ds = f('DTSTART');
    if (!ds) continue;
    const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)/.exec(ds)!;
    const s = ds.endsWith('Z') ? fromUtc(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))) : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    if (s.slice(0, 10) < today || s.slice(0, 10) > horizon) continue;
    const sum = (f('SUMMARY') ?? '').split(' - ');
    const desc = f('DESCRIPTION') ?? '';
    const ticket = /url="(https:\/\/(?:www\.)?(?:eventim|bilete|iabilet|entertix)[^"]+)"/.exec(desc)?.[1];
    const cat = f('CATEGORIES') ?? '';
    out.push({ v: 'tnt', t: cap(sum[0].trim()), s, k: /copii/i.test(cat) ? 'kids' : 'theatre', u: f('URL'), b: ticket, x: sum.length > 2 ? sum[1].replace(/"/g, '').trim() : undefined });
  }
  return out;
}

/** Opera Națională Română — pagina „Spectacole”. */
async function opera(): Promise<Ev[]> {
  const base = 'https://www.ort.ro';
  const html = await get(`${base}/ro/Spectacole.html`, await intermediate('www.ort.ro'));
  const out: Ev[] = [];
  for (const block of html.split('class="nume-tip-eveniment2').slice(1)) {
    const kind = text(/^[^>]*>([^<]*)</.exec(block)?.[1] ?? '');
    const a = /class="titlu-eveniment2"><a href="([^"]+)">([^<]+)</.exec(block);
    const author = text(/class="titlu-eveniment3">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '');
    const banner = text(/class="data-banner">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '');
    const d = /(\d{1,2})\s+([A-ZĂÂÎȘȚa-zăâîșț]+)\s+(\d{4}),?\s*Ora\s*:\s*(\d{1,2}):(\d{2})/i.exec(banner);
    if (!a || !d || !month(d[2])) continue;
    const s = `${d[3]}-${pad(month(d[2]))}-${pad(d[1])}T${pad(d[4])}:${d[5]}`;
    if (s.slice(0, 10) < today || s.slice(0, 10) > horizon) continue;
    const k: Kind = /tur/i.test(kind + a[2]) ? 'tour' : /balet|operă|operetă|musical/i.test(kind) ? 'opera' : /concert|recital/i.test(kind + a[2]) ? 'concert' : /copii/i.test(kind) ? 'kids' : 'opera';
    out.push({ v: 'opera', t: text(a[2]), a: [author, kind].filter(Boolean).join(' · ') || undefined, s, k, u: abs(base, a[1]), x: /epuizat/i.test(banner) ? 'sold' : undefined });
  }
  return out;
}

/** Teatrul German de Stat — pagina „Program”. */
async function german(): Promise<Ev[]> {
  const base = 'https://teatrulgerman.ro/ro/program/';
  const html = await get(base);
  // Linkurile „Info & bilete”, în ordinea reprezentațiilor.
  const infos = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?Info\s*(?:&amp;|&)\s*bilete/g)].map((m) => abs(base, m[1]));
  const plain = text(html);
  // „Du, 08.11.2026, 11:00 - 12:45 RO 6+ în sala Teatrului German de Stat Cartea junglei după Rudyard Kipling –– Regia … Info & bilete”
  const re = /(?:Lu|Ma|Mi|Jo|Vi|Sâ|Du),\s*(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{2}):(\d{2})(?:\s*-\s*\d{2}:\d{2})?\s+([\s\S]*?)Info & bilete/g;
  const out: Ev[] = [];
  let i = 0;
  for (const m of plain.matchAll(re)) {
    const link = infos[i++];
    const s = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
    if (s.slice(0, 10) < today || s.slice(0, 10) > horizon) continue;
    let body = m[6].trim();
    const lang = /^((?:RO|DE|EN|HU)(?:\/(?:RO|DE|EN|HU))*)\s+/.exec(body)?.[1];
    if (lang) body = body.slice(lang.length).trim();
    const age = /^(\d{1,2}\+)\s+/.exec(body)?.[1];
    if (age) body = body.slice(age.length).trim();
    // Doar reprezentațiile din Timișoara, în sala teatrului (nu turneele, festivalurile din alte orașe, școlile).
    if (!/^în sala Teatrului German de Stat\s+/.test(body)) continue;
    body = body.replace(/^în sala Teatrului German de Stat\s+/, '');
    const [head, credits] = body.split(/\s*––\s*/);
    const by = /^(.+?)\s+(după|de)\s+(.+)$/.exec(head);
    out.push({
      v: 'german', t: by ? by[1] : head, a: by ? `${by[2]} ${by[3]}` : credits?.slice(0, 80), s,
      k: age && +age.replace('+', '') <= 8 ? 'kids' : 'theatre', u: link ?? base, x: [lang, age].filter(Boolean).join(' · ') || undefined,
    });
  }
  return out;
}

/** Teatrul Maghiar „Csiky Gergely” — pagina „Program” (luna curentă și următoarea). */
async function csiky(): Promise<Ev[]> {
  const out: Ev[] = [];
  const [y, m] = today.split('-').map(Number);
  for (const [yy, mm] of [[y, m], m === 12 ? [y + 1, 1] : [y, m + 1]]) {
    const html = await get(`https://tm-t.ro/program?y=${yy}&m=${mm}`).then((h) => (h.includes('type-tribe_events') ? h : get(`https://tm-t.ro/programme?y=${yy}&m=${mm}`)));
    for (const block of html.split('class="type-tribe_events').slice(1)) {
      const title = decode(/title="([^"]+)"/.exec(block)?.[1] ?? '').trim();
      const when = /tribe-address">\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*<\/span>\s*-\s*<a>([^<]*)</.exec(block);
      if (!title || !when) continue;
      const s = `${when[1]}T${when[2]}`;
      if (s.slice(0, 10) < today || s.slice(0, 10) > horizon) continue;
      const details = /class="url" href="([^"]+)"/.exec(block)?.[1];
      const ticket = /href="(https:\/\/[^"]*(?:ticket|qrportal|bilet)[^"]*)"/.exec(block)?.[1];
      const note = text(/opacity:0\.8;">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '');
      // Turneele (Sibiu, Oradea…) nu sunt în Timișoara: păstrăm doar sălile teatrului și Casa Maghiară.
      const hall = text(when[3]);
      if (!/hall|terem|timi[șş]|sala|casa|house/i.test(hall.split('/')[0])) continue;
      out.push({ v: 'csiky', t: title, s, k: /bábsz|puppet|marionet|copii|gyerek/i.test(block) ? 'kids' : 'theatre', u: details || 'https://tm-t.ro/programme', b: decode(ticket ?? '') || undefined, x: [hall.split('/')[0].trim(), note.length < 60 ? note : ''].filter(Boolean).join(' · ') || undefined });
    }
  }
  return out;
}

/** Teatrul Merlin — programul lunii de pe prima pagină. */
async function merlin(): Promise<Ev[]> {
  const html = await get('https://www.teatrul-merlin.ro/');
  const sec = html.slice(html.indexOf('id="program"'), html.indexOf('id="program"') + 30000);
  const out: Ev[] = [];
  for (const card of sec.split('class="day-card"').slice(1)) {
    const d = /class="dc-date"[^>]*>\s*(\d{1,2})\s+([A-Za-zăâîșțĂÂÎȘȚ]+)/.exec(card);
    if (!d || !month(d[2])) continue;
    const mo = month(d[2]);
    const date = `${yearFor(mo)}-${pad(mo)}-${pad(d[1])}`;
    if (date < today || date > horizon) continue;
    for (const ev of card.split('class="dc-event"').slice(1)) {
      const times = [...text(/class="dc-time[^"]*">([\s\S]*?)<\/div>/.exec(ev)?.[1] ?? '').matchAll(/(\d{1,2}):(\d{2})/g)];
      const show = /class="dc-show">([\s\S]*?)(?:<small>|<\/div>)/.exec(ev)?.[1] ?? '';
      const raw = text(show).replace(/^[^\p{L}\d]+/u, '');
      const title = cap(raw.split(/[,/]/)[0].trim());
      const age = /(\d{1,2}\+|all family)/i.exec(raw)?.[1];
      for (const t of times.length ? times : [null]) {
        out.push({ v: 'merlin', t: title, s: t ? `${date}T${pad(t[1])}:${t[2]}` : date, k: 'kids', u: 'https://www.teatrul-merlin.ro/#program', b: 'https://www.bilete.ro/categorii/pentru-copii/teatrul-merlin/', x: age && !/family/i.test(age) ? age : undefined });
      }
    }
  }
  return out;
}

/*
 * Muzeul Național al Banatului (robots.txt nu permite citirea paginii de expoziții) și cinematografele
 * orașului (cinema-timisoara.ro își protejează programul împotriva citirii automate): pentru ele aplicația
 * arată doar legătura „Programul” către site-ul lor (VENUES.web). Muzeul de Artă nu răspunde din afara țării.
 */

/* ---------------------------------- Total ---------------------------------- */

async function main() {
  const output = process.argv[2];
  if (!output) { console.error('Folosire: build-events.ts <ieșire.json>'); process.exit(2); }
  const sources: [string, string, () => Promise<Ev[]>][] = [
    ['Opera', 'opera', opera], ['Teatrul Național', 'tnt', tnt], ['Teatrul German', 'german', german], ['Teatrul Maghiar', 'csiky', csiky],
    ['Teatrul Merlin', 'merlin', merlin], ['Filarmonica', 'fila', filarmonica],
  ];
  // Programul de ieri (--prev): dacă o sursă nu răspunde azi, îi păstrăm spectacolele care încă urmează.
  const pi = process.argv.indexOf('--prev');
  const prev: Ev[] = pi > 0 && existsSync(process.argv[pi + 1]) ? (JSON.parse(readFileSync(process.argv[pi + 1], 'utf8')).events ?? []) : [];
  const all: Ev[] = [];
  const report: string[] = [];
  for (const [name, key, fn] of sources) {
    lastFetch.length = 0;
    try {
      const ev = (await fn()).filter((e) => e.t && e.t.length > 1);
      all.push(...ev);
      report.push(`${name}: ${ev.length}`);
      if (!ev.length) { const kept = prev.filter((e) => e.v === key && (e.s ?? '') >= today); all.push(...kept); report.push(`${name}: păstrate ${kept.length}`); }
      if (!ev.length) console.log(`::warning title=Program ${name}::nimic găsit — poate s-a schimbat pagina · ${lastFetch.join(' | ').slice(0, 600)}`);
      for (const e of ev.slice(0, 3)) console.log(`::notice title=${name}::${JSON.stringify(e)}`);
    } catch (e) {
      const kept = prev.filter((x) => x.v === key && (x.s ?? '') >= today);
      all.push(...kept);
      report.push(`${name}: eroare, păstrate ${kept.length}`);
      console.log(`::warning title=Program ${name}::${String(e).slice(0, 300)} · ${lastFetch.join(' | ').slice(0, 500)}`);
    }
  }
  // Același spectacol, la aceeași oră, o singură dată.
  const seen = new Set<string>();
  const events = all.filter((e) => { const k = `${e.v}|${e.t.toLowerCase()}|${e.s}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.s ?? '9').localeCompare(b.s ?? '9') || a.t.localeCompare(b.t));
  for (const e of events) {
    e.t = cap(e.t);
    for (const k of Object.keys(e) as (keyof Ev)[]) if (e[k] === undefined || e[k] === '') delete e[k];
  }
  writeFileSync(output, JSON.stringify({ v: 1, at: now.toISOString(), venues: Object.fromEntries(Object.entries(VENUES).map(([k, v]) => [k, { n: v.n, la: v.la, lo: v.lo, m: v.match, w: v.web, ...(v.r ? { r: v.r } : {}) }])), events }));
  console.log(`::notice title=Program::${events.length} evenimente — ${report.join(', ')}`);
}

main();
