const LABELS = { RED: "Blocked", YELLOW: "At risk", GREEN: "On track" };

function statusLabel(status) {
  return LABELS[status];
}

function statusBadge(status) {
  if (status === "RED") return { label: LABELS.RED, color: "#d33", icon: "stop" };
  if (status === "YELLOW") return { label: LABELS.YELLOW, color: "#e90", icon: "warn" };
}

module.exports = { statusLabel, statusBadge, LABELS };
