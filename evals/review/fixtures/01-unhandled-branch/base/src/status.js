const LABELS = { RED: "Blocked", YELLOW: "At risk", GREEN: "On track" };

function statusLabel(status) {
  return LABELS[status];
}

module.exports = { statusLabel, LABELS };
