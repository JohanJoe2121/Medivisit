const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },

    role: {
      type: String,
      enum: ["visitor", "patient", "doctor", "security", "admin"],
      required: true
    },

    birthDate: {
      type: String,
      default: ""
    },

    address: {
      type: String,
      default: "",
      trim: true
    },

    photo: {
      type: String,
      default: ""
    },
      
    patientVisitorCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: undefined
    },

    restrictionNote: {
      type: String,
      default: ""
    }

  },
  { timestamps: true }
);

userSchema.index(
  { patientVisitorCode: 1 },
  {
    unique: true,
    partialFilterExpression: { patientVisitorCode: { $exists: true, $type: "string" } }
  }
);

module.exports = mongoose.model("User", userSchema);
