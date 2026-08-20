const INTERNAL_CONNECTOR_NAMES = new Set(['local oauth verification']);
const TERMINAL_PAIRING_PHASES = new Set(['authorized', 'revoked']);

function timestampSeconds(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

function isVisibleClient(item) {
  return !INTERNAL_CONNECTOR_NAMES.has(String(item?.client_name || '').trim().toLowerCase());
}

function newest(items, fields) {
  return [...items].sort((left, right) => {
    const leftTime = Math.max(...fields.map(field => timestampSeconds(left?.[field])));
    const rightTime = Math.max(...fields.map(field => timestampSeconds(right?.[field])));
    return rightTime - leftTime;
  })[0] || null;
}

function baseState(status, activeSessions, authorizedConnectors, pairingAttempts, subject = null) {
  return {
    status,
    detected: status !== 'disconnected',
    reconnectable: authorizedConnectors.length > 0,
    client_id: subject?.client_id || null,
    client_name: subject?.client_name || null,
    pairing_phase: subject?.pairing_status || null,
    since: subject?.connected_at || subject?.pairing_started_at || subject?.issued_at || null,
    updated_at: subject?.last_activity_at || subject?.pairing_updated_at || subject?.last_used_at || null,
    active_session_count: activeSessions.length,
    authorized_connector_count: authorizedConnectors.length,
    pairing_attempt_count: pairingAttempts.length
  };
}

/**
 * Derives the user-facing connection lifecycle without treating internal
 * launcher verification as an external AI connection.
 */
export function deriveConnectionState({
  connectors = [],
  activeSessions = [],
  now = Math.floor(Date.now() / 1_000),
  pairingTtlSeconds = 10 * 60
} = {}) {
  const visibleConnectors = connectors.filter(isVisibleClient);
  const visibleSessions = activeSessions.filter(isVisibleClient);
  const authorizedConnectors = visibleConnectors.filter(item => item.connected === true);
  const pairingAttempts = visibleConnectors.filter(item => {
    const phase = String(item.pairing_status || '');
    if (!phase || TERMINAL_PAIRING_PHASES.has(phase) || item.connected === true) return false;
    const updatedAt = timestampSeconds(item.pairing_updated_at || item.issued_at);
    const expiresAt = timestampSeconds(item.pairing_expires_at) || updatedAt + pairingTtlSeconds;
    return updatedAt > 0 && expiresAt > now;
  });

  if (visibleSessions.length > 0) {
    const subject = newest(visibleSessions, ['last_activity_at', 'connected_at']);
    return baseState('connected', visibleSessions, authorizedConnectors, pairingAttempts, subject);
  }

  // A fresh pairing attempt is more actionable than an older authorized-idle
  // connector, so surface it until the bounded pairing window expires.
  if (pairingAttempts.length > 0) {
    const subject = newest(pairingAttempts, ['pairing_updated_at', 'issued_at']);
    return baseState('pairing', visibleSessions, authorizedConnectors, pairingAttempts, subject);
  }

  if (authorizedConnectors.length > 0) {
    const subject = newest(authorizedConnectors, ['last_used_at', 'pairing_updated_at', 'issued_at']);
    return baseState('authorized', visibleSessions, authorizedConnectors, pairingAttempts, subject);
  }

  return baseState('disconnected', visibleSessions, authorizedConnectors, pairingAttempts);
}

export const connectionStateInternals = { timestampSeconds, isVisibleClient };
