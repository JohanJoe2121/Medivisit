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

/* ---------------- AUTH ---------------- */

/* ---------------- COMMON ---------------- */

// Register

// ================= ROLE-SPECIFIC API ROUTES =================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password, role, birthDate, address, photo } = req.body;

    if (!fullName || !email || !password || !role || !birthDate || !address) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const allowedRoles = ["visitor", "patient", "doctor", "security", "admin"];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role selected." });
    }

    const existingUser = await User.findOne({
      email: email.toLowerCase().trim()
    });

    if (existingUser) {
      if (existingUser.isDeleted === true) {
        const canRegisterAfter = existingUser.canRegisterAfter ? new Date(existingUser.canRegisterAfter) : null;

        if (canRegisterAfter && canRegisterAfter > new Date()) {
          return res.status(409).json({
            message: "This account was recently deleted. Please try registering again after 24 hours."
          });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        existingUser.fullName = fullName.trim();
        existingUser.password = hashedPassword;
        existingUser.role = role;
        existingUser.birthDate = birthDate;
        existingUser.address = address.trim();
        existingUser.photo = photo || "";
        existingUser.isActive = true;
        existingUser.isDeleted = false;
        existingUser.deletedAt = null;
        existingUser.canRegisterAfter = null;
        existingUser.isMainAdmin = existingUser.email === "admin@hospital.com";
        await existingUser.save();

        return res.status(201).json({
          message: "Registration successful.",
          user: {
            id: existingUser._id,
            fullName: existingUser.fullName,
            email: existingUser.email,
            role: existingUser.role,
            birthDate: existingUser.birthDate,
            address: existingUser.address,
            photo: existingUser.photo,
            isMainAdmin: existingUser.isMainAdmin === true
          }
        });
      }

      return res.status(409).json({ message: "User already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      fullName: fullName.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      role,
      birthDate,
      address: address.trim(),
      photo: photo || "",
      isMainAdmin: email.toLowerCase().trim() === "admin@hospital.com"
    });

    console.log(
      `New user registered. MongoDB User ID: ${user._id} | Email: ${user.email} | Role: ${user.role}`
    );

    return res.status(201).json({
      message: "Registration successful.",
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        birthDate: user.birthDate,
        address: user.address,
        photo: user.photo,
        isMainAdmin: user.isMainAdmin === true
      }
    });
  } catch (error) {
    return res.status(500).json({
      message: "Registration failed.",
      error: error.message
    });
  }
});

// Login

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const user = await User.findOne({
      email: email.toLowerCase().trim()
    });

    if (!user) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    if (user.isDeleted === true) {
      return res.status(403).json({ message: "This account has been deleted." });
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: "Your account is deactivated. Please contact an admin." });
    }

    if (user.role === "doctor") {
      user.role = "doctor";
      await user.save();
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const token = createToken(user);

    console.log(
      `User logged in. MongoDB User ID: ${user._id} | Email: ${user.email} | Role: ${user.role}`
    );

    return res.json({
      message: "Login successful.",
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        birthDate: user.birthDate,
        address: user.address,
        photo: user.photo,
        isMainAdmin: user.isMainAdmin === true
      }
    });
  } catch (error) {
    return res.status(500).json({
      message: "Login failed.",
      error: error.message
    });
  }
});

// Current profile

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    return res.json(user);
  } catch (error) {
    return res.status(500).json({ message: "Could not fetch profile.", error: error.message });
  }
});


app.patch("/api/auth/profile", auth, async (req, res) => {
  try {
    const { fullName, birthDate, address, photo } = req.body;

    if (!fullName || !fullName.trim()) {
      return res.status(400).json({ message: "Full name is required." });
    }

    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    user.fullName = fullName.trim();
    if (birthDate !== undefined) user.birthDate = String(birthDate || "");
    if (address !== undefined) user.address = String(address || "").trim();
    if (photo !== undefined) user.photo = photo || "";
    await user.save();

    return res.json({
      message: "Profile updated successfully.",
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        birthDate: user.birthDate,
        address: user.address,
        photo: user.photo,
        isMainAdmin: user.isMainAdmin === true
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Could not update profile.", error: error.message });
  }
});



/* ---------------- VISITOR ---------------- */

//Check for patient

app.get("/api/patients/check", async (req, res) => {
  try {
    const patientName = req.query.name?.trim();
    const patientCode = req.query.code?.trim().toUpperCase();

    if (!patientName && !patientCode) {
      return res.status(400).json({ message: "Patient name or visitor code is required." });
    }

    const patientFilter = patientCode
      ? { role: "patient", patientVisitorCode: patientCode }
      : {
          role: "patient",
          fullName: { $regex: `^${escapeRegex(patientName)}$`, $options: "i" }
        };

    const patient = await User.findOne(patientFilter).select("-password");

    if (!patient) {
      return res.status(404).json({
        exists: false,
        message: patientCode ? "Patient visitor code was not found." : "Patient not found in database."
      });
    }

    return res.json({
      exists: true,
      message: "Patient found in database.",
      patient
    });

  } catch (error) {
    return res.status(500).json({
      message: "Error checking patient.",
      error: error.message
    });
  }
});

// Create visit request

app.post("/api/visit-requests", auth, allowRoles("visitor"), async (req, res) => {
  try {
    const { patientName, patientVisitorCode, visitDate, visitTimeSlot, reason } = req.body;

    if (!visitDate || !visitTimeSlot || !reason || (!patientName && !patientVisitorCode)) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const settings = await getHospitalSettings();

    if (settings.emergencyRestrictionsEnabled) {
      return res.status(403).json({
        message: settings.emergencyRestrictionMessage || "Emergency visitor restrictions are currently enabled. New visit requests are blocked."
      });
    }

    const selectedDate = parseVisitDate(visitDate);
    if (!selectedDate) {
      return res.status(400).json({ message: "Please select a valid visit date." });
    }

    if (selectedDate < getDateOnly()) {
      return res.status(400).json({ message: "Visitors cannot request visits for past dates." });
    }

    const allowedDays = Array.isArray(settings.allowedVisitingDays)
      ? settings.allowedVisitingDays
      : [0, 1, 2, 3, 4, 5, 6];

    if (!allowedDays.includes(selectedDate.getDay())) {
      return res.status(400).json({ message: "The selected date is outside the hospital's allowed visiting days." });
    }

    const normalizedTimeSlot = normalizeTime(visitTimeSlot);
    const timeSlots = (settings.timeSlots || []).map(normalizeTime).filter(Boolean);

    if (timeSlots.length === 0) {
      return res.status(400).json({ message: "No hospital time slots are currently available. Please contact admin." });
    }

    if (!normalizedTimeSlot || !timeSlots.includes(normalizedTimeSlot)) {
      return res.status(400).json({ message: "Please select a valid hospital time slot." });
    }

    const visitingHoursStart = normalizeTime(settings.visitingHoursStart);
    const visitingHoursEnd = normalizeTime(settings.visitingHoursEnd);

    if (!isTimeWithinHours(normalizedTimeSlot, visitingHoursStart, visitingHoursEnd)) {
      return res.status(400).json({ message: "The selected time slot is outside hospital visiting hours." });
    }

    const patientFilter = patientVisitorCode
      ? { role: "patient", patientVisitorCode: String(patientVisitorCode).trim().toUpperCase() }
      : {
          role: "patient",
          fullName: { $regex: `^${escapeRegex(patientName.trim())}$`, $options: "i" }
        };

    const patient = await User.findOne(patientFilter);
    if (!patient) {
      return res.status(404).json({ message: "Patient could not be identified. Please check the visitor code." });
    }

    if (patient.visitEligibilityStatus === "Not Eligible" && patient.restrictionNote) {
      return res.status(403).json({
        message: "The patient is currently restricted by their doctor. Please try again later.",
        restrictionNote: patient.restrictionNote
      });
    }

    if (patient.visitEligibilityStatus === "Not Eligible") {
      return res.status(403).json({ message: "This patient is currently marked not eligible for visitors." });
    }

    const existingActiveRequest = await VisitRequest.findOne({
      visitorId: req.user.id,
      $or: [
        { patientId: patient._id },
        { patientName: { $regex: `^${escapeRegex(patient.fullName)}$`, $options: "i" } }
      ],
      exitedAt: null,
      status: {
        $in: ["Pending", "Approved by Patient", "Approved by Doctor", "Approved by Security"]
      }
    });

    if (existingActiveRequest) {
      return res.status(409).json({
        message: "You already have an active request for this patient. You can create another request after the current visit is expired or rejected."
      });
    }

    const activePatientRequests = await VisitRequest.countDocuments({
      $or: [
        { patientId: patient._id },
        { patientName: { $regex: `^${escapeRegex(patient.fullName)}$`, $options: "i" } }
      ],
      visitDate,
      status: { $in: ["Pending", "Approved by Patient", "Approved by Doctor", "Approved by Security"] }
    });

    if (activePatientRequests >= settings.visitorLimitPerPatient) {
      return res.status(409).json({
        message: "This patient has reached the visitor request limit for the selected date."
      });
    }

    const visitRequest = await VisitRequest.create({
      visitorId: req.user.id,
      visitorName: req.user.fullName,
      visitorEmail: req.user.email,
      patientId: patient._id,
      patientName: patient.fullName,
      patientVisitorCode: patient.patientVisitorCode || "",
      visitDate,
      visitTimeSlot: normalizedTimeSlot,
      reason: reason.trim()
    });

    notifyVisitRequestChange(visitRequest);

    return res.status(201).json({
      message: "Visit request submitted successfully.",
      visitRequest
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to submit visit request.", error: error.message });
  }
});

// Visitor's own requests

app.get("/api/visit-requests/my", auth, allowRoles("visitor"), async (req, res) => {
  try {
    await expireOldPasses({ visitorId: req.user.id });
    const requests = await VisitRequest.find({ visitorId: req.user.id }).sort({ createdAt: -1 });
    return res.json(requests);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch requests.", error: error.message });
  }
});

// Visitor approved passes

app.get("/api/visit-requests/my-passes", auth, allowRoles("visitor"), async (req, res) => {
  try {
    await expireOldPasses({ visitorId: req.user.id });
    const passes = await VisitRequest.find({
      visitorId: req.user.id,
      passCode: { $ne: "" },
      status: { $nin: ["Expired", "Cancelled"] }
    }).sort({ createdAt: -1 });

    return res.json(passes);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch passes.", error: error.message });
  }
});

app.get("/api/visit-requests/my-latest", auth, allowRoles("visitor"), async (req, res) => {
  try {
    await expireOldPasses({ visitorId: req.user.id });
    const visitRequest = await VisitRequest.findOne({ visitorId: req.user.id }).sort({ createdAt: -1 });
    return res.json({ visitRequest });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch latest request.", error: error.message });
  }
});

app.get("/api/visit-requests/my-latest/events", async (req, res) => {
  try {
    const user = await getEventUser(req);
    if (!user || user.role !== "visitor") {
      return res.status(401).end();
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const clientId = addClient(visitorStatusClients, user._id, res);
    const visitRequest = await VisitRequest.findOne({ visitorId: user._id }).sort({ createdAt: -1 });
    sendEvent(res, "visit-request-updated", visitRequest || null);

    req.on("close", () => {
      removeClient(visitorStatusClients, user._id, clientId);
    });
  } catch (error) {
    return res.status(401).end();
  }
});

app.patch("/api/visit-requests/:id/cancel", auth, allowRoles("visitor", "admin"), async (req, res) => {
  try {
    const visitRequest = await VisitRequest.findById(req.params.id);

    if (!visitRequest) {
      return res.status(404).json({ message: "Visit request not found." });
    }

    if (req.user.role === "visitor" && visitRequest.visitorId.toString() !== req.user.id) {
      return res.status(403).json({ message: "You can only cancel your own visit requests." });
    }

    await expireVisitIfNeeded(visitRequest);

    if (visitRequest.status === "Expired") {
      return res.status(409).json({ message: "This pass is already expired.", visitRequest });
    }

    visitRequest.status = "Cancelled";
    visitRequest.cancelledAt = new Date();
    visitRequest.cancelledBy = req.user.role;
    visitRequest.passCode = "";
    await visitRequest.save();

    notifyVisitRequestChange(visitRequest);

    return res.json({
      message: "Visit request cancelled successfully.",
      visitRequest
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to cancel visit request.", error: error.message });
  }
});

/* ---------------- PATIENT ---------------- */

app.post("/api/patient/visitor-code", auth, allowRoles("patient"), async (req, res) => {
  try {
    const patient = await User.findOne({ _id: req.user.id, role: "patient" }).select("-password");
    if (!patient) {
      return res.status(404).json({ message: "Patient not found." });
    }

    patient.patientVisitorCode = await createUniquePatientVisitorCode();
    await patient.save();

    return res.json({
      message: "New visitor code generated successfully.",
      patientVisitorCode: patient.patientVisitorCode
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to generate visitor code.", error: error.message });
  }
});

// View requests for review
app.get("/api/visit-requests/review", auth, allowRoles("patient", "doctor", "admin"), async (req, res) => {
  try {
    await expireOldPasses();
    const filter = {};

    if (req.user.role === "patient") {
      filter.$or = [
        { patientId: req.user.id },
        { patientName: { $regex: `^${escapeRegex(req.user.fullName)}$`, $options: "i" } }
      ];

      if (req.query.history === "full") {
        filter.$and = [
          {
            $or: [
              { status: { $in: ["Approved by Patient", "Approved by Doctor", "Approved by Security", "Rejected by Patient", "Rejected by Doctor", "Expired", "Cancelled"] } },
              { exitedAt: { $ne: null } }
            ]
          }
        ];
      } else {
        filter.status = "Pending";
      }

      const query = VisitRequest.find(filter).sort({ createdAt: -1 });
      if (req.query.history !== "full") query.limit(5);
      const requests = await query;
      return res.json(requests);
    }

    const requests = await VisitRequest.find(filter).sort({ createdAt: -1 });
    return res.json(requests);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch requests.", error: error.message });
  }
});

app.get("/api/visit-requests/review/events", async (req, res) => {
  try {
    const user = await getEventUser(req);
    if (!user || user.role !== "patient") {
      return res.status(401).end();
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const clientId = addClient(patientReviewClients, user._id, res);
    const requests = await VisitRequest.find({
      $or: [
        { patientId: user._id },
        { patientName: { $regex: `^${escapeRegex(user.fullName)}$`, $options: "i" } }
      ],
      status: "Pending"
    }).sort({ createdAt: -1 }).limit(5);
    sendEvent(res, "patient-requests-updated", requests);

    req.on("close", () => {
      removeClient(patientReviewClients, user._id, clientId);
    });
  } catch (error) {
    return res.status(401).end();
  }
});

// Approve / reject request
app.patch("/api/visit-requests/:id/status", auth, allowRoles("patient", "doctor"), async (req, res) => {
  try {
    const { status } = req.body;
    const requestId = req.params.id;

    const allowedStatuses = [
      "Approved by Patient",
      "Rejected by Patient",
      "Approved by Doctor",
      "Rejected by Doctor"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status value." });
    }

    const visitRequest = await VisitRequest.findById(requestId);
    if (!visitRequest) {
      return res.status(404).json({ message: "Visit request not found." });
    }

    if (req.user.role === "patient" && !status.includes("Patient")) {
      return res.status(403).json({ message: "Patients can only apply patient status changes." });
    }

    if (req.user.role === "patient") {
      const matchesPatient = visitRequest.patientId
        ? visitRequest.patientId.toString() === req.user.id
        : visitRequest.patientName.toLowerCase() === req.user.fullName.toLowerCase();

      if (!matchesPatient) {
        return res.status(403).json({ message: "Patients can only update their own visit requests." });
      }
    }

    if (req.user.role === "doctor" && !status.includes("Doctor")) {
      return res.status(403).json({ message: "Doctors can only apply doctor status changes." });
    }

    visitRequest.status = status;
    visitRequest.passCode = status.startsWith("Approved") ? generatePassCode() : "";
    visitRequest.expiresAt = status.startsWith("Approved") ? getVisitDayEnd(visitRequest.visitDate) : null;
    await visitRequest.save();
    notifyVisitRequestChange(visitRequest);

    return res.json({
      message: "Visit request updated successfully.",
      visitRequest
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update visit request.", error: error.message });
  }
});

/* ---------------- SECURITY PERSONNEL ---------------- */
app.get("/api/security/approved-visits", auth, allowRoles("security"), async (req, res) => {
  try {
    await expireOldPasses();
    const approvedVisits = await VisitRequest.find({
      $or: [
        { verifiedBySecurity: true },
        { exitedAt: { $ne: null } },
        { status: "Expired" }
      ]
    }).sort({ createdAt: -1 });
    return res.json(approvedVisits);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch approved visits.", error: error.message });
  }
});

app.get("/api/security/current-checkins", auth, allowRoles("security"), async (req, res) => {
  try {
    await expireOldPasses();
    const visits = await VisitRequest.find({
      securityApprovedAt: { $ne: null },
      exitedAt: null,
      status: { $nin: ["Cancelled", "Expired", "Exited", "Completed"] }
    }).sort({ securityApprovedAt: -1 });

    return res.json(visits.map(visit => ({
      ...visit.toObject(),
      exitAvailableAt: getExitAvailableAt(visit),
      exitRemainingSeconds: getExitRemainingSeconds(visit)
    })));
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch current check-ins.", error: error.message });
  }
});

app.get("/api/security/checkout-history", auth, allowRoles("security"), async (req, res) => {
  try {
    await expireOldPasses();
    const visits = await VisitRequest.find({
      $or: [
        { exitedAt: { $ne: null } },
        { status: { $in: ["Exited", "Completed"] } }
      ]
    }).sort({ exitedAt: -1, updatedAt: -1 });

    return res.json(visits);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch check-out history.", error: error.message });
  }
});

// Verify pass code
app.post("/api/security/check-pass", auth, allowRoles("security"), async (req, res) => {
  try {
    const { passCode } = req.body;

    if (!passCode) {
      return res.status(400).json({ message: "Pass code is required." });
    }

    const visit = await VisitRequest.findOne({ passCode: passCode.trim().toUpperCase() });

    if (!visit) {
      return res.status(404).json({ message: "Invalid pass code." });
    }

    await expireVisitIfNeeded(visit);

    if (visit.status === "Cancelled") {
      return res.status(409).json({ message: "Pass cancelled.", visit });
    }

    if (visit.status === "Expired") {
      return res.status(409).json({ message: "Pass expired.", visit });
    }

    if (visit.status === "Exited" || visit.status === "Completed" || visit.exitedAt) {
      return res.status(409).json({ message: "Visitor already exited. This pass cannot be used again.", visit });
    }

    return res.json({
      message: "Valid pass.",
      visit,
      exitAvailableAt: getExitAvailableAt(visit),
      exitRemainingSeconds: getExitRemainingSeconds(visit)
    });
  } catch (error) {
    return res.status(500).json({ message: "Pass check failed.", error: error.message });
  }
});

// Approve scanned pass code
app.post("/api/security/verify-pass", auth, allowRoles("security"), async (req, res) => {
  try {
    const { passCode } = req.body;

    if (!passCode) {
      return res.status(400).json({ message: "Pass code is required." });
    }

    const visit = await VisitRequest.findOne({ passCode: passCode.trim().toUpperCase() });

    if (!visit) {
      return res.status(404).json({ message: "Invalid pass code." });
    }

    await expireVisitIfNeeded(visit);

    if (visit.status === "Cancelled") {
      return res.status(409).json({ message: "Pass is cancelled.", visit });
    }

    if (visit.status === "Expired") {
      return res.status(409).json({ message: "Pass is expired.", visit });
    }

    if (visit.status === "Exited" || visit.status === "Completed" || visit.exitedAt) {
      return res.status(409).json({ message: "Visitor already exited. This pass cannot be used for another entry.", visit });
    }

    if (visit.verifiedBySecurity || visit.securityApprovedAt) {
      return res.status(409).json({
        message: "Visitor is already checked in. Use the exit action after the timer ends.",
        visit,
        exitAvailableAt: getExitAvailableAt(visit),
        exitRemainingSeconds: getExitRemainingSeconds(visit)
      });
    }

    const settings = await getHospitalSettings();
    if (settings.emergencyRestrictionsEnabled && !visit.verifiedBySecurity) {
      return res.status(403).json({
        message: settings.emergencyRestrictionMessage || "Emergency restrictions are active. Future entries are blocked.",
        visit
      });
    }

    visit.verifiedBySecurity = true;
    visit.status = "Approved by Security";
    visit.securityApprovedAt = visit.securityApprovedAt || new Date();
    visit.expiresAt = visit.expiresAt || getVisitDayEnd(visit.visitDate);
    await visit.save();
    notifyVisitRequestChange(visit);

    return res.json({
      message: "Pass approved by security.",
      visit,
      exitAvailableAt: getExitAvailableAt(visit),
      exitRemainingSeconds: getExitRemainingSeconds(visit)
    });
  } catch (error) {
    return res.status(500).json({ message: "Pass verification failed.", error: error.message });
  }
});

// Mark approved visitor as exited and expire the pass
app.post("/api/security/exit-pass", auth, allowRoles("security"), async (req, res) => {
  try {
    const { passCode } = req.body;

    if (!passCode) {
      return res.status(400).json({ message: "Pass code is required." });
    }

    const visit = await VisitRequest.findOne({ passCode: passCode.trim().toUpperCase() });

    if (!visit) {
      return res.status(404).json({ message: "Invalid pass code." });
    }

    await expireVisitIfNeeded(visit);

    if (visit.status === "Cancelled") {
      return res.status(409).json({ message: "Pass is cancelled.", visit });
    }

    if (visit.status === "Expired") {
      return res.status(409).json({ message: "Pass is already expired.", visit });
    }

    if (visit.status === "Exited" || visit.status === "Completed" || visit.exitedAt) {
      return res.status(409).json({ message: "Visitor has already exited.", visit });
    }

    if (!visit.verifiedBySecurity || !visit.securityApprovedAt) {
      return res.status(400).json({ message: "Pass must be approved by security before exit.", visit });
    }

    const remainingSeconds = getExitRemainingSeconds(visit);
    if (remainingSeconds > 0) {
      return res.status(409).json({
        message: `Exit available in ${remainingSeconds} seconds.`,
        visit,
        exitAvailableAt: getExitAvailableAt(visit),
        exitRemainingSeconds: remainingSeconds
      });
    }

    visit.exitedAt = new Date();
    visit.status = "Exited";
    await visit.save();
    notifyVisitRequestChange(visit);

    return res.json({
      message: "Visitor exit recorded.",
      visit,
      exitAvailableAt: getExitAvailableAt(visit),
      exitRemainingSeconds: 0
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to record exit.", error: error.message });
  }
});

/* ---------------- ADMIN ---------------- */

app.delete("/api/account/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (user.email === "admin@hospital.com" || user.isMainAdmin === true) {
      return res.status(403).json({ message: "The main admin account cannot be deleted." });
    }

    const deletedAt = new Date();
    const canRegisterAfter = new Date(deletedAt.getTime() + 24 * 60 * 60 * 1000);

    user.isDeleted = true;
    user.deletedAt = deletedAt;
    user.canRegisterAfter = canRegisterAfter;
    user.isActive = false;
    await user.save();

    return res.json({
      message: "Your account has been deleted. It may take up to 24 hours before you can register again."
    });
  } catch (error) {
    return res.status(500).json({ message: "Could not delete account.", error: error.message });
  }
});

app.get("/api/hospital-settings", auth, async (req, res) => {
  try {
    const settings = await getHospitalSettings();
    return res.json(settings);
  } catch (error) {
    return res.status(500).json({ message: "Failed to load hospital settings.", error: error.message });
  }
});

app.get("/api/admin/users", auth, allowRoles("admin"), async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 }).lean();
    const usersWithId = users.map(user => ({
      ...user,
      id: user._id.toString()
    }));
    return res.json(usersWithId);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch users.", error: error.message });
  }
});

app.get("/api/admin/users/export-pdf", auth, allowRoles("admin"), async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ role: 1, fullName: 1 }).lean();
    const lines = [
      "Medivisit System Users Report",
      `Generated: ${formatPdfDate(new Date())}`,
      "",
      "Full name                     Email                         Role       Status     Created",
      "------------------------------------------------------------------------------------------"
    ];

    if (!users.length) {
      lines.push("No users found.");
    } else {
      users.forEach(user => {
        lines.push(
          `${truncatePdfCell(user.fullName, 29).padEnd(29)} ` +
          `${truncatePdfCell(user.email, 29).padEnd(29)} ` +
          `${truncatePdfCell(user.role, 10).padEnd(10)} ` +
          `${(user.isActive === false ? "Inactive" : "Active").padEnd(10)} ` +
          `${user.createdAt ? new Date(user.createdAt).toISOString().slice(0, 10) : "-"}`
        );
      });
    }

    return sendPdf(res, "medivisit-users-report.pdf", lines);
  } catch (error) {
    return res.status(500).json({ message: "Failed to export users PDF.", error: error.message });
  }
});

// Admin activate/deactivate user
app.patch("/api/admin/users/:id/status", auth, allowRoles("admin"), async (req, res) => {
  try {
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive must be true or false." });
    }

    if (req.params.id === req.user.id && isActive === false) {
      return res.status(400).json({ message: "You cannot deactivate your own admin account." });
    }

    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if ((user.email === "admin@hospital.com" || user.isMainAdmin === true) && isActive === false) {
      return res.status(400).json({ message: "The main admin account cannot be deactivated." });
    }

    user.isActive = isActive;
    await user.save();

    return res.json({
      message: isActive ? "User activated successfully." : "User deactivated successfully.",
      user
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update user status.", error: error.message });
  }
});

// Admin: all visit requests
app.get("/api/admin/visit-requests", auth, allowRoles("admin"), async (req, res) => {
  try {
    await expireOldPasses();
    const settings = await getHospitalSettings();
    const now = new Date();
    const requests = await VisitRequest.find({
      status: { $nin: ["Cancelled", "Rejected", "Rejected by Patient", "Rejected by Doctor", "Expired", "Completed", "Checked Out", "Exited"] },
      exitedAt: null
    }).sort({ createdAt: -1 });

    const activeRequests = [];

    for (const request of requests) {
      if (isActiveVisitRequest(request, settings, now)) {
        activeRequests.push(request);
        continue;
      }

      if (!isInactiveVisitRequest(request)) {
        request.status = "Expired";
        request.expiresAt = request.expiresAt || getVisitExpiryDate(request, settings);
        await request.save();
      }
    }

    return res.json(activeRequests);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch visit requests.", error: error.message });
  }
});

// Admin create admin
app.post("/api/admin/create-admin", auth, allowRoles("admin"), async (req, res) => {
  try {
    const { fullName, email, password, birthDate, address, photo } = req.body;

    if (!fullName || !email || !password || !birthDate || !address) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(409).json({ message: "User already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = await User.create({
      fullName: fullName.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      role: "admin",
      birthDate,
      address: address.trim(),
      photo: photo || "",
      isMainAdmin: false
    });

    return res.status(201).json({
      message: "Admin account created successfully.",
      admin: {
        id: admin._id,
        fullName: admin.fullName,
        email: admin.email,
        role: admin.role,
        birthDate: admin.birthDate,
        address: admin.address,
        photo: admin.photo
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create admin.", error: error.message });
  }
});

app.get("/api/admin/doctors", auth, allowRoles("admin"), async (req, res) => {
  const doctors = await User.find({ role: "doctor" }).select("-password");
  res.json(doctors);
});

app.get("/api/admin/unassigned-patients", auth, allowRoles("admin"), async (req, res) => {
  const patients = await User.find({
    role: "patient",
    assignedDoctor: null
  }).select("-password");

  res.json(patients);
});

app.patch("/api/admin/assign-doctor", auth, allowRoles("admin"), async (req, res) => {
  try {
    const { patientId, doctorId } = req.body;

    const patient = await User.findOne({ _id: patientId, role: "patient" });
    const doctor = await User.findOne({ _id: doctorId, role: "doctor" });

    if (!patient) return res.status(404).json({ message: "Patient not found." });
    if (!doctor) return res.status(404).json({ message: "Doctor not found." });

    patient.assignedDoctor = doctor._id;
    await patient.save();

    res.json({
      message: "Patient assigned to doctor successfully.",
      patient
    });
  } catch (error) {
    res.status(500).json({ message: "Doctor assignment failed.", error: error.message });
  }
});

app.patch("/api/admin/visit-requests/:id/override", auth, allowRoles("admin"), async (req, res) => {
  const request = await VisitRequest.findById(req.params.id);

  if (!request) {
    return res.status(404).json({ message: "Visit request not found." });
  }

  const settings = await getHospitalSettings();
  if (!isActiveVisitRequest(request, settings)) {
    if (!isInactiveVisitRequest(request)) {
      request.status = "Expired";
      request.expiresAt = request.expiresAt || getVisitExpiryDate(request, settings);
      await request.save();
    }

    return res.status(400).json({ message: "Only active, non-expired visit requests can be overridden." });
  }

  request.status = "Approved by Security";
  request.passCode = request.passCode || generatePassCode();
  request.expiresAt = request.expiresAt || getVisitExpiryDate(request, settings) || getVisitDayEnd(request.visitDate);
  request.verifiedBySecurity = true;
  request.securityApprovedAt = new Date();

  await request.save();
  notifyVisitRequestChange(request);

  res.json({
    message: "Visit approval overridden by admin.",
    request
  });
});

app.get("/api/admin/settings", auth, allowRoles("admin"), async (req, res) => {
  try {
    const settings = await getHospitalSettings();
    return res.json(settings);
  } catch (error) {
    return res.status(500).json({ message: "Failed to load settings.", error: error.message });
  }
});

app.put("/api/admin/settings", auth, allowRoles("admin"), async (req, res) => {
  try {
    const {
      visitingHoursStart,
      visitingHoursEnd,
      visitorLimitPerPatient,
      visitDurationMinutes,
      timeSlots,
      allowedVisitingDays,
      emergencyRestrictionsEnabled,
      emergencyRestrictionMessage
    } = req.body;

    const settings = await getHospitalSettings();

    const normalizedStart = normalizeTime(visitingHoursStart) || settings.visitingHoursStart;
    const normalizedEnd = normalizeTime(visitingHoursEnd) || settings.visitingHoursEnd;

    if (normalizedStart >= normalizedEnd) {
      return res.status(400).json({ message: "Visiting hours start must be before end time." });
    }

    const normalizedSlots = Array.isArray(timeSlots)
      ? timeSlots.map(normalizeTime).filter(Boolean)
      : settings.timeSlots;

    const invalidSlots = normalizedSlots.filter(slot => !isTimeWithinHours(slot, normalizedStart, normalizedEnd));
    if (invalidSlots.length) {
      return res.status(400).json({ message: "All time slots must be inside visiting hours." });
    }

    settings.visitingHoursStart = normalizedStart;
    settings.visitingHoursEnd = normalizedEnd;
    settings.visitorLimitPerPatient = Number(visitorLimitPerPatient) > 0 ? Number(visitorLimitPerPatient) : settings.visitorLimitPerPatient;
    settings.visitDurationMinutes = Number(visitDurationMinutes) > 0 ? Number(visitDurationMinutes) : settings.visitDurationMinutes;
    settings.timeSlots = Array.isArray(timeSlots)
      ? [...new Set(normalizedSlots)]
      : settings.timeSlots;
    settings.allowedVisitingDays = Array.isArray(allowedVisitingDays)
      ? allowedVisitingDays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
      : settings.allowedVisitingDays;
    settings.emergencyRestrictionsEnabled = Boolean(emergencyRestrictionsEnabled);
    settings.emergencyRestrictionMessage = emergencyRestrictionMessage || "";

    await settings.save();

    return res.json({
      message: "Hospital settings updated successfully.",
      settings
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update settings.", error: error.message });
  }
});

app.get("/api/admin/system-activity", auth, allowRoles("admin"), async (req, res) => {
  await expireOldPasses();
  const latestUsers = await User.find().select("-password").sort({ createdAt: -1 }).limit(5);
  const latestRequests = await VisitRequest.find().sort({ createdAt: -1 }).limit(5);

  res.json({
    latestUsers,
    latestRequests
  });
});

app.get("/api/admin/system-activity/export-pdf", auth, allowRoles("admin"), async (req, res) => {
  try {
    const from = parseVisitDate(req.query.from);
    const to = parseVisitDate(req.query.to);

    if (!from || !to) {
      return res.status(400).json({ message: "Valid from and to dates are required." });
    }

    if (from > to) {
      return res.status(400).json({ message: "From date must be before or equal to To date." });
    }

    const rangeEnd = new Date(to);
    rangeEnd.setHours(23, 59, 59, 999);

    const dateFilter = { $gte: from, $lte: rangeEnd };
    const users = await User.find({ createdAt: dateFilter }).select("-password").sort({ createdAt: 1 }).lean();
    const requests = await VisitRequest.find({ createdAt: dateFilter }).sort({ createdAt: 1 }).lean();
    const activityRows = makeActivityRows(users, requests);

    const lines = [
      "Medivisit System Activity Report",
      `From date: ${req.query.from}`,
      `To date: ${req.query.to}`,
      `Generated: ${formatPdfDate(new Date())}`,
      "",
      "Date/time             User/role                    Action/activity              Status/details",
      "-----------------------------------------------------------------------------------------------"
    ];

    if (!activityRows.length) {
      lines.push("No system activity found for the selected dates.");
    } else {
      activityRows.forEach(row => {
        lines.push(
          `${truncatePdfCell(formatPdfDate(row.date), 21).padEnd(21)} ` +
          `${truncatePdfCell(row.user, 28).padEnd(28)} ` +
          `${truncatePdfCell(row.action, 28).padEnd(28)} ` +
          `${truncatePdfCell(row.details, 18)}`
        );
      });
    }

    return sendPdf(res, "medivisit-system-activity-report.pdf", lines);
  } catch (error) {
    return res.status(500).json({ message: "Failed to export system activity PDF.", error: error.message });
  }
});

/* ---------------- COMPLAINTS SYSTEM---------------- */

app.post("/api/complaints", auth, allowRoles("visitor", "patient", "doctor", "security"), async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ message: "Subject and complaint message are required." });
    }

    const complaint = await Complaint.create({
      userId: req.user.id,
      userName: req.user.fullName,
      userEmail: req.user.email,
      userRole: req.user.role,
      subject: subject.trim(),
      message: message.trim(),
      status: "Open"
    });

    return res.status(201).json({
      message: "Complaint submitted successfully.",
      complaint
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to submit complaint.", error: error.message });
  }
});

app.get("/api/complaints/my", auth, allowRoles("visitor", "patient", "doctor", "security"), async (req, res) => {
  try {
    const complaints = await Complaint.find({
      userId: req.user.id,
      userRole: req.user.role
    }).sort({ createdAt: -1 });

    return res.json(complaints);
  } catch (error) {
    return res.status(500).json({ message: "Failed to load your complaints.", error: error.message });
  }
});

app.get("/api/admin/complaints", auth, allowRoles("admin"), async (req, res) => {
  try {
    const complaints = await Complaint.find().sort({ createdAt: -1 });
    return res.json(complaints);
  } catch (error) {
    return res.status(500).json({ message: "Failed to load complaints.", error: error.message });
  }
});

app.patch("/api/admin/complaints/:id/reply", auth, allowRoles("admin"), async (req, res) => {
  try {
    const { adminReply, status } = req.body;
    const validStatuses = ["Open", "In Progress", "Resolved"];

    if (!adminReply || !adminReply.trim()) {
      return res.status(400).json({ message: "Reply text is required." });
    }

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid complaint status." });
    }

    const complaint = await Complaint.findById(req.params.id);

    if (!complaint) {
      return res.status(404).json({ message: "Complaint not found." });
    }

    complaint.adminReply = adminReply.trim();
    complaint.status = status;
    complaint.repliedBy = req.user.id;
    complaint.repliedAt = new Date();
    await complaint.save();

    return res.json({
      message: "Complaint reply saved.",
      complaint
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to reply to complaint.", error: error.message });
  }
});

app.get("/api/admin/escalations", auth, allowRoles("admin"), async (req, res) => {
  try {
    const escalations = await Escalation.find().sort({ createdAt: -1 });
    return res.json(escalations);
  } catch (error) {
    return res.status(500).json({ message: "Failed to load escalations.", error: error.message });
  }
});

app.patch("/api/admin/escalations/:id/resolve", auth, allowRoles("admin"), async (req, res) => {
  try {
    const escalation = await Escalation.findById(req.params.id);

    if (!escalation) {
      return res.status(404).json({ message: "Escalation not found." });
    }

    escalation.status = "Resolved";
    escalation.resolvedAt = new Date();
    escalation.resolvedBy = req.user.id;
    await escalation.save();

    return res.json({
      message: "Escalation marked as resolved.",
      escalation
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to resolve escalation.", error: error.message });
  }
});

/* ---------------- DOCTOR---------------- */
app.get("/api/doctor/my-patients", auth, allowRoles("doctor"), async (req, res) => {
  const patients = await User.find({
    role: "patient",
    assignedDoctor: req.user.id
  }).select("-password");

  res.json(patients);
});-

app.patch("/api/doctor/patients/:patientId/visit-rules", auth, allowRoles("doctor"), async (req, res) => {
  try {
    const { visitEligibility } = req.body;
    const restrictionNote = String(req.body.restrictionNote || "").trim();
    const eligibilityMap = {
      allowed: "Eligible",
      restricted: "Not Eligible"
    };

    if (!Object.prototype.hasOwnProperty.call(eligibilityMap, visitEligibility)) {
      return res.status(400).json({ message: "Visit eligibility must be allowed or restricted." });
    }

    if (visitEligibility === "restricted" && !restrictionNote) {
      return res.status(400).json({ message: "Restriction note is required when restricting a patient." });
    }

    if (restrictionNote.length > 1000) {
      return res.status(400).json({ message: "Restriction note must be 1000 characters or less." });
    }

    const patient = await User.findOne({
      _id: req.params.patientId,
      role: "patient",
      assignedDoctor: req.user.id
    }).select("-password");

    if (!patient) {
      return res.status(404).json({ message: "Assigned patient not found." });
    }

    patient.visitEligibilityStatus = eligibilityMap[visitEligibility];
    patient.restrictionNote = visitEligibility === "allowed" ? "" : restrictionNote;
    await patient.save();

    return res.json({
      message: "Patient visit rules saved.",
      patient
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save patient visit rules.", error: error.message });
  }
});


/* ---------------- FRONTEND ROUTES ---------------- */
const frontendRoutes = {
  "/": ["common", "index.html"],
"/login": ["common", "login.html"],
  "/register": ["common", "register.html"],
  "/login.html": ["common", "login.html"],
  "/register.html": ["common", "register.html"],
  "/visitor-dashboard.html": ["visitor", "visitor.html"],
  "/visitor.html": ["visitor", "visitor.html"],
  "/visitor-history.html": ["visitor", "visitor-history.html"],
  "/patient-register.html": ["common", "patient-register.html"],
"/patient-dashboard.html": ["patient", "patient.html"],
  "/patient.html": ["patient", "patient.html"],
  "/security-personnel-register.html": ["common", "security-personnel-register.html"],
"/qr-code.html": ["visitor", "qr-code.html"],
  "/security-dashboard.html": ["security-personnel", "security-personnel.html"],
  "/security-personnel.html": ["security-personnel", "security-personnel.html"],
  "/scanner.html": ["security-personnel", "scanner.html"],
  "/security-history.html": ["security-personnel", "security-history.html"],
  "/doctor-register.html": ["common", "doctor-register.html"],
"/doctor-dashboard.html": ["doctor", "doctor.html"],
  "/doctor.html": ["doctor", "doctor.html"],
  "/admin-dashboard.html": ["admin", "admin.html"],
  "/admin.html": ["admin", "admin.html"],
  "/admin-register.html": ["admin", "admin-register.html"]
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
  