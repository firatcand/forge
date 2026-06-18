import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSearchProvider, ScanningSearchProvider } from '../../../src/search/index.ts';
import { SearchError } from '../../../src/search/types.ts';

test('createSearchProvider — native → a ScanningSearchProvider (the public chokepoint)', () => {
  const provider = createSearchProvider({ provider: 'native' });
  assert.ok(provider instanceof ScanningSearchProvider);
});

test('createSearchProvider — exa/parallel/perplexity → NOT_IMPLEMENTED with guidance', () => {
  for (const provider of ['exa', 'parallel', 'perplexity'] as const) {
    assert.throws(
      () => createSearchProvider({ provider }),
      (e: unknown) =>
        e instanceof SearchError &&
        e.code === 'NOT_IMPLEMENTED' &&
        e.message.includes(provider) &&
        /native/.test(e.message),
      provider,
    );
  }
});
