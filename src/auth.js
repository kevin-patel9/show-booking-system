const { HttpError } = require("./errors");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin";

function getToken(req) {
  const header = req.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Any token except the admin token is a normal user. The token is the user id.
function requireUser(req, res, next) {
  const token = getToken(req);

  if (!token) return next(new HttpError(401, "unauthorized", "Bearer token required"));
  if (token === ADMIN_TOKEN) return next(new HttpError(403, "forbidden", "Admins cannot book seats"));

  req.userId = token;
  next();
}

function requireAdmin(req, res, next) {
  const token = getToken(req);

  if (!token) return next(new HttpError(401, "unauthorized", "Bearer token required"));
  if (token !== ADMIN_TOKEN) return next(new HttpError(403, "forbidden", "Admin token required"));

  next();
}

module.exports = { requireUser, requireAdmin };
