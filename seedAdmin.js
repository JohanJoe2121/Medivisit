const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const User = require("./models/User");

async function seedAdmin() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const existingAdmin = await User.findOne({ email: "admin@hospital.com" });
    const hashedPassword = await bcrypt.hash("admin123", 10);
    await User.updateMany(
      { email: { $ne: "admin@hospital.com" }, isMainAdmin: true },
      { $set: { isMainAdmin: false } }
    );

    if (existingAdmin) {
      existingAdmin.fullName = "Main Admin";
      existingAdmin.password = hashedPassword;
      existingAdmin.role = "admin";
      existingAdmin.isActive = true;
      existingAdmin.isDeleted = false;
      existingAdmin.deletedAt = null;
      existingAdmin.canRegisterAfter = null;
      existingAdmin.isMainAdmin = true;
      await existingAdmin.save();

      console.log("Default admin already existed and was updated.");
      console.log("Email: admin@hospital.com");
      console.log("Password: admin123");
      process.exit(0);
    }

    await User.create({
      fullName: "Main Admin",
      email: "admin@hospital.com",
      password: hashedPassword,
      role: "admin",
      isActive: true,
      isMainAdmin: true
    });

    console.log("Default admin created successfully.");
    console.log("Email: admin@hospital.com");
    console.log("Password: admin123");
    process.exit(0);
  } catch (error) {
    console.error("Failed to seed admin:", error.message);
    process.exit(1);
  }
}

seedAdmin();
