import { db } from "./db.js";
import { statusBadge } from "./status.js";

export function renderDashboard() {
  const rows = db.projects.map((project) => {
    const { label, color } = statusBadge(project.status);
    return `<tr><td>${project.name}</td><td style="color:${color}">${label}</td></tr>`;
  });
  return `<table>${rows.join("")}</table>`;
}
