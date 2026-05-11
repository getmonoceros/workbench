import { describe, expect, it } from 'vitest';

import { CORE_PACKAGE_NAME } from '../src/index.js';

describe('@monoceros/core smoke', () => {
  it('exposes its package identifier', () => {
    expect(CORE_PACKAGE_NAME).toBe('@monoceros/core');
  });
});
