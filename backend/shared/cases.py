"""Investigation case state machine (shared by API and tests)."""

NEW = "NEW"
UNDER_REVIEW = "UNDER_REVIEW"
ESCALATED = "ESCALATED"
DISMISSED = "DISMISSED"
RESOLVED = "RESOLVED"

STATUSES = [NEW, UNDER_REVIEW, ESCALATED, DISMISSED, RESOLVED]

TRANSITIONS = {
    NEW: [UNDER_REVIEW, ESCALATED, DISMISSED],
    UNDER_REVIEW: [ESCALATED, DISMISSED, RESOLVED],
    ESCALATED: [UNDER_REVIEW, DISMISSED, RESOLVED],
    DISMISSED: [UNDER_REVIEW],
    RESOLVED: [UNDER_REVIEW],
}

# A reason is mandatory when closing a case or reopening a closed one.
REASON_REQUIRED = {DISMISSED, RESOLVED}
CLOSED = {DISMISSED, RESOLVED}

MAX_REASON = 500
MIN_REASON = 5
MAX_COMMENT = 1000


class TransitionError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def check_transition(current: str, target: str, reason):
    if target not in STATUSES:
        raise TransitionError("INVALID_STATUS", "Unknown case status.")
    if target == current:
        raise TransitionError("NO_OP_TRANSITION", "The case is already in that status.")
    if target not in TRANSITIONS.get(current, []):
        raise TransitionError("INVALID_TRANSITION",
                              "Cannot move a case from " + current + " to " + target + ".")
    needs_reason = target in REASON_REQUIRED or current in CLOSED
    text = reason.strip() if isinstance(reason, str) else ""
    if needs_reason and len(text) < MIN_REASON:
        raise TransitionError("REASON_REQUIRED",
                              "A reason of at least 5 characters is required for this transition.")
    if len(text) > MAX_REASON:
        raise TransitionError("REASON_TOO_LONG", "The reason must be at most 500 characters.")
    return text


def case_id_for(dataset_id: str, record_id: str) -> str:
    """Deterministic: one case per record per dataset (idempotent creation)."""
    return "CASE-" + dataset_id + "-" + record_id
