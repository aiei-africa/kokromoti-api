import { Resend } from "resend";

// Reused across every Ayivi Solutions product — one Resend account,
// multiple verified sending domains. Set RESEND_API_KEY and
// EMAIL_FROM ("Kokromoti <noreply@kokromoti.aiei-africa.org>") per product.
//
// Defensive check: only construct the client if the key looks like a real
// Resend key (starts with "re_", ASCII only). Anything else — blank,
// placeholder text accidentally pasted in, whitespace — is treated the
// same as "not configured" rather than crashing the whole server on boot.
const rawKey = process.env.RESEND_API_KEY?.trim();
const looksValid = rawKey && /^re_[A-Za-z0-9_]+$/.test(rawKey);
const resend = looksValid ? new Resend(rawKey) : null;

if (rawKey && !looksValid) {
  console.warn(
    `[email] RESEND_API_KEY is set but doesn't look like a valid Resend key — ignoring it and running in log-only mode. Check .env for stray placeholder text.`
  );
}

export async function sendVerificationEmail(to: string, fullName: string, verifyUrl: string) {
  if (!resend) {
    console.warn(`[email] RESEND_API_KEY not set — skipping send. Would have emailed ${to}: ${verifyUrl}`);
    return { skipped: true };
  }

  return resend.emails.send({
    from: process.env.EMAIL_FROM || "Kokromoti <noreply@kokromoti.aiei-africa.org>",
    to,
    subject: "Verify your Kokromoti account",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color:#0a1220;">Welcome to Kokromoti, ${fullName}.</h2>
        <p style="color:#333;">Confirm your email to activate your account.</p>
        <a href="${verifyUrl}" style="display:inline-block; background:#b8860f; color:#fff; padding:12px 24px; border-radius:6px; text-decoration:none; margin-top:12px;">
          Verify Email
        </a>
        <p style="color:#888; font-size:12px; margin-top:24px;">
          If you didn't create this account, you can ignore this email.
        </p>
      </div>
    `,
  });
}
