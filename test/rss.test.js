import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../src/rss.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Blog</title>
  <link>https://example.com</link>
  <item><title>First &amp; foremost</title><link>https://example.com/1</link><pubDate>Tue, 10 Jun 2025 12:00:00 GMT</pubDate></item>
  <item><title><![CDATA[Second post]]></title><link>https://example.com/2</link><pubDate>Mon, 09 Jun 2025 12:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <entry><title>Atom one</title><link rel="alternate" href="https://a.example/one"/><updated>2025-06-10T10:00:00Z</updated></entry>
  <entry><title>Atom two</title><link href="https://a.example/two"/><published>2025-06-09T10:00:00Z</published></entry>
</feed>`;

test('parses an RSS 2.0 feed', () => {
  const f = parseFeed(RSS);
  assert.equal(f.title, 'Example Blog');
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].title, 'First & foremost'); // entities decoded
  assert.equal(f.items[0].link, 'https://example.com/1');
  assert.ok(f.items[0].date);
  assert.equal(f.items[1].title, 'Second post'); // CDATA unwrapped
});

test('parses an Atom feed and prefers the alternate link', () => {
  const f = parseFeed(ATOM);
  assert.equal(f.title, 'Atom Example');
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].title, 'Atom one');
  assert.equal(f.items[0].link, 'https://a.example/one');
  assert.equal(f.items[1].link, 'https://a.example/two');
  assert.ok(f.items[0].date);
});

test('respects the item limit', () => {
  assert.equal(parseFeed(RSS, 1).items.length, 1);
});

test('returns no items for non-feed content', () => {
  assert.equal(parseFeed('<html><body>not a feed</body></html>').items.length, 0);
});
