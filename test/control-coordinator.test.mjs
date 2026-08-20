import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AsyncFifoMutex,
  DesktopControlBusyError,
  DesktopControlCoordinator,
  findWorkspaceConflict
} from '../src/control-coordinator.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('AsyncFifoMutex runs concurrent work one-at-a-time in arrival order', async () => {
  const mutex = new AsyncFifoMutex();
  const order = [];
  let active = 0;
  let maxActive = 0;
  const tasks = [1, 2, 3, 4].map(index => mutex.run(async () => {
    order.push(`start-${index}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(4);
    active -= 1;
    order.push(`end-${index}`);
  }));
  await Promise.all(tasks);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start-1', 'end-1', 'start-2', 'end-2',
    'start-3', 'end-3', 'start-4', 'end-4'
  ]);
});

test('desktop lease blocks another connector while allowing its owner', async () => {
  const coordinator = new DesktopControlCoordinator();
  const alpha = { id: 'session-alpha', label: 'Alpha AI' };
  const beta = { id: 'session-beta', label: 'Beta AI' };

  const acquired = await coordinator.acquire(alpha, { purpose: 'multi-step form edit', ttlMs: 30_000 });
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.owned_by_requester, true);
  assert.equal(await coordinator.runInput(alpha, 'mouse_move', async () => 'allowed'), 'allowed');
  await assert.rejects(
    coordinator.runInput(beta, 'mouse_click', async () => 'must not run'),
    error => error instanceof DesktopControlBusyError && error.code === 'DESKTOP_CONTROL_BUSY'
  );
  assert.equal((await coordinator.release(beta)).released, false);
  assert.equal((await coordinator.release(alpha)).released, true);
  assert.equal(await coordinator.runInput(beta, 'mouse_click', async () => 'now allowed'), 'now allowed');
});

test('desktop lease follows one authenticated connector across MCP sessions', async () => {
  const coordinator = new DesktopControlCoordinator();
  const firstSession = { id: 'oauth-client:chatgpt', label: 'ChatGPT session one' };
  const nextSession = { id: 'oauth-client:chatgpt', label: 'ChatGPT session two' };

  assert.equal((await coordinator.acquire(firstSession, { ttlMs: 30_000 })).acquired, true);
  assert.equal(await coordinator.runInput(nextSession, 'browser_open', async () => 'continued'), 'continued');
  assert.equal(coordinator.status(nextSession.id).owned_by_requester, true);
  assert.equal((await coordinator.release(nextSession)).released, true);
});

test('expired desktop lease is automatically reclaimed', async () => {
  let now = 10_000;
  const coordinator = new DesktopControlCoordinator({ now: () => now });
  const alpha = { id: 'session-alpha', label: 'Alpha AI' };
  const beta = { id: 'session-beta', label: 'Beta AI' };

  await coordinator.acquire(alpha, { ttlMs: 5_000 });
  now += 5_001;
  assert.equal(coordinator.status(beta.id).state, 'available');
  assert.equal(await coordinator.runInput(beta, 'type_text', async () => 'reclaimed'), 'reclaimed');
});

test('an authenticated connector can explicitly release its desktop lease', async () => {
  const coordinator = new DesktopControlCoordinator();
  const alpha = { id: 'session-alpha', label: 'Alpha AI' };
  await coordinator.acquire(alpha, { ttlMs: 30_000 });
  assert.equal(await coordinator.releaseOwner(alpha.id), true);
  assert.equal(coordinator.status(alpha.id).state, 'available');
});

test('same Windows workspace is reserved case-insensitively for one background agent', () => {
  const running = [{ id: 'job-one', cwd: 'C:\\Work\\Project', ownerLabel: 'Alpha AI' }];
  assert.equal(findWorkspaceConflict(running, 'c:\\work\\project', 'win32')?.id, 'job-one');
  assert.equal(findWorkspaceConflict(running, 'C:\\Work\\Project-worktree', 'win32'), null);
});
