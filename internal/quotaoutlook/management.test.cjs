const test = require('node:test');
const assert = require('node:assert/strict');
const {windowGeometry} = require('./management.js');
const day = date => Date.parse(date + 'T00:00:00Z');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('Kimi usage keeps its actual endpoint when October history and November expiry are offscreen', () => {
  const from = day('2026-10-28'), to = day('2026-11-28');
  const start = day('2026-11-01'), end = day('2026-11-15');
  const bar = windowGeometry(from, to, start, end, 76);
  close(bar.left, 0);
  close(bar.width, 100);
  // 24% of 31 days ends 7.44 days after October 28, or 3.44 days after November 1.
  close(bar.fill, 3.44 / 14 * 100);
  assert.equal(bar.continuesBefore, true);
  assert.equal(bar.continuesAfter, true);
  const full = windowGeometry(from, to, from, to, 76);
  close(from + full.fill / 100 * (to - from), start + bar.fill / 100 * (end - start));
});

test('weekly usage before the visible Monday does not restart at Monday', () => {
  const bar = windowGeometry(day('2026-10-30'), day('2026-11-06'), day('2026-11-02'), day('2026-11-16'), 90);
  assert.equal(bar.fill, 0);
  close(bar.width, 4 / 14 * 100);
});

test('usage beyond the right edge fills the whole visible portion', () => {
  const bar = windowGeometry(day('2026-10-28'), day('2026-11-28'), day('2026-11-01'), day('2026-11-15'), 10);
  assert.equal(bar.fill, 100);
});

test('unclipped windows retain the reported percentage, including empty and exhausted', () => {
  for (const remaining of [0, 24, 76, 100]) {
    const bar = windowGeometry(10, 20, 0, 30, remaining);
    close(bar.fill, 100 - remaining);
    assert.equal(bar.continuesBefore, false);
    assert.equal(bar.continuesAfter, false);
  }
});

test('future and past windows have no invented usage and non-overlapping windows are omitted', () => {
  assert.equal(windowGeometry(10, 20, 0, 30, null).fill, null);
  assert.equal(windowGeometry(10, 20, 20, 30, 76), null);
  assert.equal(windowGeometry(10, 20, 0, 10, 76), null);
});
