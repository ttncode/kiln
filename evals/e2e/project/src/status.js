const LABELS = { RED: "Blocked", YELLOW: "At risk", GREEN: "On track" };

export function statusLabel(status) {
  return LABELS[status];
}

export function statusBadge(status) {
  if (status === "RED") return { label: LABELS.RED, color: "#d33" };
  if (status === "YELLOW") return { label: LABELS.YELLOW, color: "#e90" };
}
