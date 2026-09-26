const { statusBadge } = require("./status");

function renderRow(project) {
  const { label, color, icon } = statusBadge(project.status);
  return `<tr><td>${project.name}</td><td style="color:${color}"><i class="${icon}"></i>${label}</td></tr>`;
}

function renderDashboard(projects) {
  return `<table>${projects.map(renderRow).join("")}</table>`;
}

module.exports = { renderDashboard };
