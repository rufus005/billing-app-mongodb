import jwt from "jsonwebtoken";
export function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ");
    if (token?.[0] !== "Bearer") throw Error();
    const claims = jwt.verify(token[1], process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "billing-app",
    });
    if (claims.sub !== process.env.ADMIN_USERNAME) throw Error();
    next();
  } catch {
    res
      .status(401)
      .json({ message: "Unauthorized session. Please log in again." });
  }
}
