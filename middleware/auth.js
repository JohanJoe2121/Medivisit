const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function auth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Access denied. No token provided." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({ message: "Account no longer exists." });
    }

    if (user.isDeleted === true) {
      return res.status(403).json({ message: "This account has been deleted." });
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: "Your account has been deactivated." });
    }

    req.user = {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      isMainAdmin: user.isMainAdmin === true
    };

    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access forbidden." });
    }
    next();
  };
}

module.exports = { auth, allowRoles };
