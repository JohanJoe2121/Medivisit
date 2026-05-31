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
  