import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

let Router;

beforeAll(async () => {
  window.addEventListener = () => {};
  window.location = { hash: '' };
  await import('../app/router.js');
  Router = globalThis.AiduRouter;
});

describe('Router startup', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('renders the default library route on an empty hash', () => {
    const router = new Router({});
    let calls = 0;
    router.register('library', () => { calls += 1; });
    router.start();
    expect(calls).toBe(1);
  });
});
