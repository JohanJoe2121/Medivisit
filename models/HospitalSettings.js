const mongoose = require("mongoose");

const hospitalSettingsSchema = new mongoose.Schema(
  {
    visitingHoursStart: {
      type: String,
      default: "09:00"
    },
    visitingHoursEnd: {
      type: String,
      default: "17:00"
    },
    visitorLimitPerPatient: {
      type: Number,
      default: 2
    },
    visitDurationMinutes: {
      type: Number,
      default: 30
    },
    timeSlots: {
      type: [String],
      default: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]
    },
    allowedVisitingDays: {
      type: [Number],
      default: [0, 1, 2, 3, 4, 5, 6]
    },
    emergencyRestrictionsEnabled: {
      type: Boolean,
      default: false
    },
    emergencyRestrictionMessage: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("HospitalSettings", hospitalSettingsSchema);
