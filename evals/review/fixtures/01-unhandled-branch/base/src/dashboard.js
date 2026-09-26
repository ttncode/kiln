const { statusLabel } = require("./status");

function renderRow(project) {
  return `<tr><td>${project.name}</td><td>${statusLabel(project.status)}</td></tr>`;
}

function renderDashboard(projects) {
  return `<table>${projects.map(renderRow).join("")}</table>`;
}

module.exports = { renderDashboard };
