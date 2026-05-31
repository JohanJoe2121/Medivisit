const mongoose = require("mongoose");

const visitRequestSchema = new mongoose.Schema(
  {
    visitorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    visitorName: {
      type: String,
      required: true,
      trim: true
    },
    visitorEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    patientName: {
      type: String,
      required: true,
      trim: true
    },
    patientVisitorCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: ""
    },
    visitDate: {
      type: String,
      required: true
    },
    visitTimeSlot: {
      type: String,
      trim: true,
      default: ""
    },
    reason: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      enum: ["Pending", "Approved by Patient", "Rejected by Patient", "Approved by Doctor", "Rejected by Doctor", "Approved by Security", "Cancelled", "Expired", "Exited", "Completed"],
      default: "Pending"
    },
    passCode: {
      type: String,
      default: ""
    },
    verifiedBySecurity: {
      type: Boolean,
      default: false
    },
    securityApprovedAt: {
      type: Date,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null
    },
    cancelledAt: {
      type: Date,
      default: null
    },
    cancelledBy: {
      type: String,
      enum: ["", "visitor", "patient", "doctor", "security", "admin", "system"],
      default: ""
    },
    exitedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("VisitRequest", visitRequestSchema);
