import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { requestLogger } from "./middleware/requestLogger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

import electionsRouter from "./routes/elections";
import geographyRouter from "./routes/geography";
import resultsRouter from "./routes/results";
import candidatesRouter from "./routes/candidates";
import partiesRouter from "./routes/parties";
import authRouter from "./routes/auth";

const app = express();

app.use(cors({
  origin: [
    "https://kokromoti.aiei-africa.org",
    "http://localhost:3000",
  ],
}));
app.use(express.json());
app.use(requestLogger);

// Global rate limit — generous, since none of this is gated yet.
app.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get("/health", (_req, res) => {
  res.json({ service: "kokromoti-api", status: "ok", operator: "AIEI" });
});

app.use("/elections", electionsRouter);
app.use("/geography", geographyRouter);
app.use("/results", resultsRouter);
app.use("/candidates", candidatesRouter);
app.use("/parties", partiesRouter);
app.use("/auth", authRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`kokromoti-api listening on :${PORT}`));
