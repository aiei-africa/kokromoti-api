import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signAccessToken, signVerificationToken, verifyToken } from "../lib/jwt";
import { sendVerificationEmail } from "../lib/email";
import { asyncHandler, ApiError } from "../middleware/errorHandler";

const router = Router();

// POST /auth/register — no feature is gated behind this; it exists so the
// account and future upgrade path are there when walls come later.
router.post("/register", asyncHandler(async (req, res) => {
  const { email, password, fullName, phone } = req.body;
  if (!email || !password || !fullName) {
    throw new ApiError(400, "email, password, and fullName are required");
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(409, "An account with this email already exists");

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email, passwordHash, fullName, phone: phone || null },
  });

  const verifyToken = signVerificationToken(user.id);
  const verifyUrl = `${process.env.WEB_APP_URL || "https://kokromoti.aiei-africa.org"}/verify-email?token=${verifyToken}`;
  const emailResult = await sendVerificationEmail(email, fullName, verifyUrl);

  res.status(201).json({
    message: "Account created. Check your email to verify — verification is optional and does not block any current feature.",
    user: { id: user.id, email: user.email, fullName: user.fullName },
    emailSent: !("skipped" in emailResult),
  });
}));

// GET /auth/verify-email?token=... — sets emailVerifiedAt, nothing else changes
router.get("/verify-email", asyncHandler(async (req, res) => {
  const token = String(req.query.token || "");
  const payload = verifyToken(token);
  if (!payload || payload.type !== "verify-email") throw new ApiError(400, "Invalid or expired verification link");

  await prisma.user.update({
    where: { id: payload.sub },
    data: { emailVerifiedAt: new Date() },
  });
  res.json({ message: "Email verified." });
}));

// POST /auth/login — returns an access token; no route currently requires it
router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, "email and password are required");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new ApiError(401, "Invalid email or password");
  }
  if (user.status !== "ACTIVE") throw new ApiError(403, "Account is not active");

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const accessToken = signAccessToken(user.id);
  res.json({
    accessToken,
    user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role, emailVerified: !!user.emailVerifiedAt },
  });
}));

export default router;
