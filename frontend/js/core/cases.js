// Investigation case state machine (port of backend/shared/cases.py).

export const STATUSES = ['NEW', 'UNDER_REVIEW', 'ESCALATED', 'DISMISSED', 'RESOLVED'];
export const TRANSITIONS = {
  NEW: ['UNDER_REVIEW', 'ESCALATED', 'DISMISSED'],
  UNDER_REVIEW: ['ESCALATED', 'DISMISSED', 'RESOLVED'],
  ESCALATED: ['UNDER_REVIEW', 'DISMISSED', 'RESOLVED'],
  DISMISSED: ['UNDER_REVIEW'],
  RESOLVED: ['UNDER_REVIEW'],
};
export const CLOSED = ['DISMISSED', 'RESOLVED'];
export const STATUS_LABELS = {
  NEW: 'New',
  UNDER_REVIEW: 'Under review',
  ESCALATED: 'Escalated',
  DISMISSED: 'Dismissed',
  RESOLVED: 'Resolved',
};
export const MAX_COMMENT = 1000;

export class TransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function needsReason(current, target) {
  return CLOSED.includes(target) || CLOSED.includes(current);
}

export function checkTransition(current, target, reason) {
  if (!STATUSES.includes(target)) throw new TransitionError('INVALID_STATUS', 'Unknown case status.');
  if (target === current) throw new TransitionError('NO_OP_TRANSITION', 'The case is already in that status.');
  if (!(TRANSITIONS[current] || []).includes(target)) {
    throw new TransitionError('INVALID_TRANSITION', 'Cannot move a case from ' + current + ' to ' + target + '.');
  }
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (needsReason(current, target) && text.length < 5) {
    throw new TransitionError('REASON_REQUIRED', 'A reason of at least 5 characters is required for this transition.');
  }
  if (text.length > 500) throw new TransitionError('REASON_TOO_LONG', 'The reason must be at most 500 characters.');
  return text;
}

export function caseIdFor(datasetId, recordId) {
  return 'CASE-' + datasetId + '-' + recordId;
}
