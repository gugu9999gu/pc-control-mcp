import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveConnectionState } from '../src/connection-state.mjs';

test('internal launcher verification is never shown as an external AI connection', () => {
  const result = deriveConnectionState({
    now: 1_000,
    connectors: [{
      client_id: 'internal', client_name: 'local OAuth verification', connected: true,
      pairing_status: 'authorized', last_used_at: 999
    }],
    activeSessions: [{ client_name: 'local OAuth verification', connected_at: 999 }]
  });
  assert.equal(result.status, 'disconnected');
  assert.equal(result.detected, false);
});

test('pairing attempts are visible only inside their bounded lifetime', () => {
  const connector = {
    client_id: 'chatgpt', client_name: 'ChatGPT', connected: false,
    pairing_status: 'awaiting_authorization', pairing_started_at: 900,
    pairing_updated_at: 950, pairing_expires_at: 1_050
  };
  const pairing = deriveConnectionState({ now: 1_000, connectors: [connector] });
  assert.equal(pairing.status, 'pairing');
  assert.equal(pairing.client_name, 'ChatGPT');
  assert.equal(pairing.pairing_phase, 'awaiting_authorization');

  const expired = deriveConnectionState({ now: 1_051, connectors: [connector] });
  assert.equal(expired.status, 'disconnected');
});

test('live MCP sessions, new pairing, and authorized idle have distinct states', () => {
  const authorized = {
    client_id: 'claude', client_name: 'Claude', connected: true,
    pairing_status: 'authorized', last_used_at: 900
  };
  assert.equal(deriveConnectionState({ now: 1_000, connectors: [authorized] }).status, 'authorized');

  const pairing = {
    client_id: 'chatgpt', client_name: 'ChatGPT', connected: false,
    pairing_status: 'registered', pairing_updated_at: 999, pairing_expires_at: 1_100
  };
  const currentPairing = deriveConnectionState({ now: 1_000, connectors: [authorized, pairing] });
  assert.equal(currentPairing.status, 'pairing');
  assert.equal(currentPairing.client_name, 'ChatGPT');

  const connected = deriveConnectionState({
    now: 1_000,
    connectors: [authorized, pairing],
    activeSessions: [{ client_id: 'claude', client_name: 'Claude', connected_at: 995, last_activity_at: 999 }]
  });
  assert.equal(connected.status, 'connected');
  assert.equal(connected.active_session_count, 1);
  assert.equal(connected.client_name, 'Claude');
});
