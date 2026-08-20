import { resolve } from 'node:path';

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function workspaceReservationKey(path, platform = process.platform) {
  const normalized = resolve(path);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function findWorkspaceConflict(jobs, cwd, platform = process.platform) {
  const requestedKey = workspaceReservationKey(cwd, platform);
  return jobs.find(job => workspaceReservationKey(job.cwd, platform) === requestedKey) || null;
}

export class AsyncFifoMutex {
  #tail = Promise.resolve();
  #active = false;
  #waiting = 0;

  get depth() {
    return this.#waiting + (this.#active ? 1 : 0);
  }

  async run(callback) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const previous = this.#tail;
    this.#tail = previous.then(() => gate, () => gate);
    this.#waiting += 1;
    await previous.catch(() => {});
    this.#waiting -= 1;
    this.#active = true;
    try {
      return await callback();
    } finally {
      this.#active = false;
      release();
    }
  }
}

export class DesktopControlBusyError extends Error {
  constructor(snapshot) {
    const owner = snapshot.owner_label || 'another connected AI';
    const expiry = snapshot.expires_at ? ` until ${snapshot.expires_at}` : '';
    super(`Desktop control is reserved by ${owner}${expiry}. Wait for the lease to be released or expire, then retry.`);
    this.name = 'DesktopControlBusyError';
    this.code = 'DESKTOP_CONTROL_BUSY';
    this.snapshot = snapshot;
  }
}

function requireOwner(owner) {
  if (!owner || typeof owner.id !== 'string' || !owner.id.trim()) {
    throw new Error('A stable MCP session owner is required for desktop coordination.');
  }
  return {
    id: owner.id.trim(),
    label: String(owner.label || 'connected AI').trim().slice(0, 160) || 'connected AI'
  };
}

export class DesktopControlCoordinator {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.sleep = options.sleep || defaultSleep;
    this.mutex = new AsyncFifoMutex();
    this.lease = null;
  }

  #clearExpired() {
    if (this.lease && this.lease.expiresAt <= this.now()) this.lease = null;
  }

  #snapshot(requesterId = null) {
    this.#clearExpired();
    if (!this.lease) {
      return {
        state: 'available',
        owner_label: null,
        purpose: null,
        acquired_at: null,
        expires_at: null,
        remaining_ms: 0,
        owned_by_requester: false,
        queue_depth: this.mutex.depth
      };
    }
    return {
      state: 'leased',
      owner_label: this.lease.ownerLabel,
      purpose: this.lease.purpose,
      acquired_at: new Date(this.lease.acquiredAt).toISOString(),
      expires_at: new Date(this.lease.expiresAt).toISOString(),
      remaining_ms: Math.max(0, this.lease.expiresAt - this.now()),
      owned_by_requester: Boolean(requesterId && requesterId === this.lease.ownerId),
      queue_depth: this.mutex.depth
    };
  }

  status(requesterId = null) {
    return this.#snapshot(requesterId);
  }

  async acquire(ownerValue, options = {}) {
    const owner = requireOwner(ownerValue);
    const purpose = String(options.purpose || 'coordinated desktop operation').trim().slice(0, 240);
    const ttlMs = Math.min(600_000, Math.max(5_000, Number(options.ttlMs) || 60_000));
    const waitMs = Math.min(30_000, Math.max(0, Number(options.waitMs) || 0));
    const deadline = this.now() + waitMs;

    while (true) {
      const result = await this.mutex.run(async () => {
        this.#clearExpired();
        if (!this.lease || this.lease.ownerId === owner.id) {
          const acquiredAt = this.lease?.acquiredAt || this.now();
          this.lease = {
            ownerId: owner.id,
            ownerLabel: owner.label,
            purpose,
            acquiredAt,
            expiresAt: this.now() + ttlMs,
            ttlMs
          };
          return { acquired: true, ...this.#snapshot(owner.id) };
        }
        return { acquired: false, ...this.#snapshot(owner.id) };
      });

      if (result.acquired || this.now() >= deadline) return result;
      await this.sleep(Math.min(100, Math.max(1, deadline - this.now())));
    }
  }

  async release(ownerValue) {
    const owner = requireOwner(ownerValue);
    return this.mutex.run(async () => {
      this.#clearExpired();
      if (!this.lease) return { released: false, reason: 'no_active_lease', ...this.#snapshot(owner.id) };
      if (this.lease.ownerId !== owner.id) {
        return { released: false, reason: 'owned_by_another_session', ...this.#snapshot(owner.id) };
      }
      this.lease = null;
      return { released: true, reason: 'released', ...this.#snapshot(owner.id) };
    });
  }

  async releaseOwner(ownerId) {
    if (!ownerId) return false;
    return this.mutex.run(async () => {
      this.#clearExpired();
      if (this.lease?.ownerId !== ownerId) return false;
      this.lease = null;
      return true;
    });
  }

  async runInput(ownerValue, operation, callback) {
    const owner = requireOwner(ownerValue);
    return this.mutex.run(async () => {
      this.#clearExpired();
      if (this.lease && this.lease.ownerId !== owner.id) {
        throw new DesktopControlBusyError(this.#snapshot(owner.id));
      }
      if (this.lease?.ownerId === owner.id) {
        this.lease.expiresAt = this.now() + this.lease.ttlMs;
      }
      return callback({ operation, coordination: this.#snapshot(owner.id) });
    });
  }
}
