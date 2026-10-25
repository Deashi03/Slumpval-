import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const js = readFileSync('app.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
const sw = readFileSync('sw.js', 'utf8');
const manifest = JSON.parse(readFileSync('manifest.webmanifest', 'utf8'));

function extractFunction(name, nextName) {
  const start = js.indexOf('  function ' + name + '(');
  const end = js.indexOf('  function ' + nextName + '(', start + 1);
  assert.ok(start >= 0 && end > start);
  return js.slice(start, end);
}

test('every literal referenced ID exists in the HTML', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const refs = [...js.matchAll(/\$\("([^"]+)"\)/g)].map(match => match[1]);
  for (const id of refs) assert.ok(ids.has(id), 'Missing element: ' + id);
  for (const view of ['draw', 'list', 'add']) {
    assert.ok(ids.has('view-' + view));
    assert.ok(ids.has('tab' + view[0].toUpperCase() + view.slice(1)));
  }
  for (const screen of ['loading', 'setup', 'unlock', 'app']) assert.ok(ids.has('screen-' + screen));
});

test('Enter, CRLF, and CR become separate alternatives; blanks ignored', () => {
  const splitLines = new Function(extractFunction('splitLines', 'newId') + '\nreturn splitLines;')();
  assert.deepEqual(splitLines('A\nB\r\nC\rD\n\n  \n E '), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('samma\nsamma'), ['samma', 'samma']);
  assert.deepEqual(splitLines('x'.repeat(9000)), ['x'.repeat(9000)]);
});

test('random selection index always stays in range', () => {
  const uniformIndex = new Function('crypto', extractFunction('uniformIndex', 'splitLines') + '\nreturn uniformIndex;')(webcrypto);
  assert.equal(uniformIndex(0), -1);
  for (const count of [1, 2, 3, 7, 100, 1000]) {
    const result = new Set();
    for (let i = 0; i < 250; i++) {
      const value = uniformIndex(count);
      assert.ok(Number.isInteger(value) && value >= 0 && value < count);
      result.add(value);
    }
    if (count <= 7) assert.equal(result.size, count);
  }
});

test('sensitive list remains local and app shell is the only offline cache', () => {
  assert.match(js, /indexedDB\.open\(/);
  assert.match(js, /crypto\.subtle\.encrypt/);
  assert.match(js, /crypto\.subtle\.decrypt/);
  assert.match(js, /PBKDF2/);
  assert.match(js, /AES-GCM/);
  assert.match(js, /commitIfCurrent\(/);
  assert.match(js, /document\.addEventListener\("visibilitychange"/);
  assert.doesNotMatch(js, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|WebSocket/);
  assert.doesNotMatch(sw, /indexedDB|localStorage/);
  assert.match(sw, /Only cache PUBLIC app-shell files/);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.display, 'standalone');
});
