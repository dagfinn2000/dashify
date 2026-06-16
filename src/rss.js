// RSS 2.0 / Atom feeds for the dashboard's side pane. Fetched and parsed on the
// server (so the browser sidesteps CORS) and returned as a small, normalised
// { title, items: [{ title, link, date }] } shape. No XML dependency — the
// parser is deliberately tolerant, since homelab feeds vary a lot.
import { request } from './widgets.js';

// Unescape XML entities and drop any stray inline markup, leaving plain text.
function decodeText(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => codePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function codePoint(n) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

// First inner text of <name>…</name> (optionally namespaced, e.g. dc:date).
function field(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decodeText(m[1]) : '';
}

// Atom entries carry several <link> elements; prefer the human-facing one.
function atomLink(block) {
  const tags = block.match(/<link\b[^>]*\/?>/gi) || [];
  const pick =
    tags.find((t) => /rel=["']?alternate/i.test(t)) ||
    tags.find((t) => !/rel=/i.test(t)) ||
    tags[0] ||
    '';
  const href = pick.match(/href=["']([^"']+)["']/i);
  return href ? decodeText(href[1]) : '';
}

export function parseFeed(xml, limit = 20) {
  const text = String(xml || '');
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const entry = isAtom ? 'entry' : 'item';

  // The feed's own title lives in the head, before the first item/entry.
  const head = text.split(new RegExp(`<${entry}[\\s>]`, 'i'))[0];
  const blocks = text.match(new RegExp(`<${entry}[\\s>][\\s\\S]*?<\\/${entry}>`, 'gi')) || [];

  const items = [];
  for (const b of blocks) {
    const title = field(b, 'title');
    let link = isAtom ? atomLink(b) : field(b, 'link');
    if (!isAtom && !link) {
      const guid = field(b, 'guid');
      if (/^https?:\/\//i.test(guid)) link = guid;
    }
    const date =
      field(b, 'pubDate') || field(b, 'published') || field(b, 'updated') || field(b, 'dc:date');
    if (title || link) items.push({ title, link, date });
    if (items.length >= limit) break;
  }

  return { title: field(head, 'title'), items };
}

export async function fetchFeed(url, { timeoutMs = 8000, insecure = false, limit = 20 } = {}) {
  const res = await request(url, {
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
      'user-agent': 'Dashify/rss',
    },
    timeoutMs,
    insecure,
  });
  if (res.status >= 400) throw new Error(`feed responded with HTTP ${res.status}`);
  const feed = parseFeed(res.body, limit);
  if (!feed.items.length && !/<(rss|feed)[\s>]/i.test(res.body)) {
    throw new Error('not an RSS or Atom feed');
  }
  return feed;
}
