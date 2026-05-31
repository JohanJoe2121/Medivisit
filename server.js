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
  