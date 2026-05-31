const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
require("dotenv").config();

const User = require("./models/User");
const VisitRequest = require("./models/VisitRequest");
const HospitalSettings = require("./models/HospitalSettings");
const Complaint = require("./models/Complaint");
const Escalation = require("./models/Escalation");
const { auth, allowRoles } = require("./middleware/auth");

const app = express();
const publicRoot = path.join(__dirname, "public");
const frontendRoot = path.join(publicRoot, "html");
const visitorStatusClients = new Map();
const patientReviewClients = new Map();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(frontendRoot));
app.use(express.static(publicRoot));

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected successfully"))
  .catch((error) => {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  });

//VISITOR HELPER FUNCTIONS

function addClient(clientMap, key, res) {
  const clientKey = String(key);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const clients = clientMap.get(clientKey) || new Map();
  clients.set(id, res);
  clientMap.set(clientKey, clients);
  return id;
}

function removeClient(clientMap, key, id) {
  const clientKey = String(key);
  const clients = clientMap.get(clientKey);
  if (!clients) return;
  clients.delete(id);
  if (clients.size === 0) clientMap.delete(clientKey);
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function notifyClients(clientMap, key, event, data) {
  const clients = clientMap.get(String(key));
  if (!clients) return;
  for (const res of clients.values()) {
    sendEvent(res, event, data);
  }
}

function notifyVisitRequestChange(visitRequest) {
  if (!visitRequest) return;
  notifyClients(visitorStatusClients, visitRequest.visitorId, "visit-request-updated", visitRequest);
  if (visitRequest.patientId) {
    notifyClients(patientReviewClients, visitRequest.patientId, "patient-requests-updated", visitRequest);
  }
}

async function getEventUser(req) {
  const rawToken = req.query.token || "";
  const token = String(rawToken).replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  return User.findById(decoded.id).select("-password");
}

//PATIENT HELPER FUNCTIONS

function generatePassCode() {
  return "PASS-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generatePatientVisitorCode() {
  return "PAT-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function createUniquePatientVisitorCode() {
  let code = generatePatientVisitorCode();
  let existing = await User.findOne({ patientVisitorCode: code });

  while (existing) {
    code = generatePatientVisitorCode();
    existing = await User.findOne({ patientVisitorCode: code });
  }

  return code;
}

//ADMIN HELPER FUNCTIONS

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getDateOnly(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function parseVisitDate(visitDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(visitDate))) {
    return null;
  }

  const date = new Date(`${visitDate}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getVisitDayEnd(visitDate) {
  const date = parseVisitDate(visitDate);
  if (!date) return null;
  date.setHours(23, 59, 59, 999);
  return date;
}

function normalizeTime(value) {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return "";
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function isTimeWithinHours(timeSlot, start, end) {
  return timeSlot >= start && timeSlot <= end;
}


async function getHospitalSettings() {
  let settings = await HospitalSettings.findOne();

  if (!settings) {
    settings = await HospitalSettings.create({});
  }

  return settings;
}

function getVisitExpiryDate(visit, settings) {
  const explicitExpiry = visit.expiresAt || visit.passExpiresAt || visit.qrExpiresAt || visit.visitEndTime;
  if (explicitExpiry) return new Date(explicitExpiry);

  const visitDate = parseVisitDate(visit.visitDate);
  if (!visitDate) return null;

  const slot = normalizeTime(visit.visitTimeSlot);
  if (!slot) return getVisitDayEnd(visit.visitDate);

  const [hours, minutes] = slot.split(":").map(Number);
  const expiryDate = new Date(`${visit.visitDate}T00:00:00`);
  expiryDate.setHours(hours, minutes, 0, 0);
  expiryDate.setMinutes(expiryDate.getMinutes() + Number(settings?.visitDurationMinutes || 30));
  return expiryDate;
}

function isInactiveVisitRequest(visit) {
  const inactiveStatuses = [
    "Cancelled",
    "Rejected",
    "Rejected by Patient",
    "Rejected by Doctor",
    "Expired",
    "Completed",
    "Checked Out",
    "Exited"
  ];

  return inactiveStatuses.includes(visit.status) || Boolean(visit.checkedOutAt || visit.exitTime || visit.exitedAt);
}

function isActiveVisitRequest(visit, settings, now = new Date()) {
  if (isInactiveVisitRequest(visit)) return false;

  const expiryDate = getVisitExpiryDate(visit, settings);
  if (expiryDate && expiryDate < now) return false;

  return true;
}

function escapePdfText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[\r\n\t]+/g, " ");
}

function createSimplePdf(lines) {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 42;
  const lineHeight = 14;
  const maxLines = Math.floor((pageHeight - margin * 2) / lineHeight);
  const safeLines = lines.length ? lines : [""];
  const pages = [];

  for (let index = 0; index < safeLines.length; index += maxLines) {
    pages.push(safeLines.slice(index, index + maxLines));
  }

  const objects = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);

  pages.forEach((pageLines, index) => {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const content = [
      "BT",
      "/F1 10 Tf",
      `${margin} ${pageHeight - margin} Td`,
      ...pageLines.map((line, lineIndex) => `${lineIndex === 0 ? "" : `0 -${lineHeight} Td `}(${escapePdfText(line)}) Tj`),
      "ET"
    ].join("\n");

    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> /Contents ${contentObjectNumber} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  });

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}

function sendPdf(res, filename, lines) {
  const pdf = createSimplePdf(lines);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", pdf.length);
  return res.send(pdf);
}

function formatPdfDate(value) {
  return value ? new Date(value).toLocaleString("en-AU", { timeZone: "Australia/Sydney" }) : "-";
}

function truncatePdfCell(value, length) {
  const text = String(value ?? "-").replace(/\s+/g, " ").trim() || "-";
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function makeActivityRows(users, requests) {
  const userRows = users.map(user => ({
    date: user.createdAt,
    user: `${user.fullName} (${user.role})`,
    action: "User account created",
    details: user.isActive === false ? "Inactive" : "Active"
  }));

  const requestRows = requests.map(request => ({
    date: request.createdAt,
    user: `${request.visitorName} (visitor)`,
    action: `Visit request for ${request.patientName}`,
    details: request.status || "-"
  }));

  return [...userRows, ...requestRows].sort((a, b) => new Date(a.date) - new Date(b.date));
}

function createToken(user) {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      fullName: user.fullName
    },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );
}

//SECURITY PERSONNEL HELPER FUNCTIONS

function getExitAvailableAt(visit) {
  if (!visit || !visit.securityApprovedAt) return null;
  return new Date(new Date(visit.securityApprovedAt).getTime() + 30000);
}

function getExitRemainingSeconds(visit) {
  const exitAvailableAt = getExitAvailableAt(visit);
  if (!exitAvailableAt) return null;
  return Math.max(0, Math.ceil((exitAvailableAt.getTime() - Date.now()) / 1000));
}

async function expireVisitIfNeeded(visit) {
  if (!visit || visit.status === "Expired" || visit.status === "Cancelled" || visit.status === "Exited" || visit.status === "Completed") {
    return visit;
  }

  const expiresAt = visit.expiresAt || getVisitDayEnd(visit.visitDate);
  if (expiresAt && new Date() > expiresAt) {
    visit.status = "Expired";
    visit.expiresAt = expiresAt;
    await visit.save();
  }

  return visit;
}

async function expireOldPasses(filter = {}) {
  const now = new Date();
  await VisitRequest.updateMany(
    {
      ...filter,
      expiresAt: { $ne: null, $lt: now },
      status: { $nin: ["Expired", "Cancelled", "Exited", "Completed"] }
    },
    { $set: { status: "Expired" } }
  );
}

/* ---------------- FRONTEND ROUTES ---------------- */
const frontendRoutes = {

};

for (const [route, fileParts] of Object.entries(frontendRoutes)) {
    app.get(route, (req, res) => {
      res.sendFile(path.join(frontendRoot, ...fileParts));
    });
  }
  
const PORT = process.env.PORT || 3000;
  
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  