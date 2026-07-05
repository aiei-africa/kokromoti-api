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
import favouritesRouter from "./routes/favourites";

const app = express();

app.set("trust proxy", 1);

app.use(cors({
  origin: [
    "https://kokromoti.aiei-africa.org",
    "https://kokromoti-web-production.up.railway.app",
    "http://localhost:3000",
  ],
}));
app.use(express.json());
app.use(requestLogger);

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
app.use("/favourites", favouritesRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, "0.0.0.0", () => console.log(`kokromoti-api listening on 0.0.0.0:${PORT}`));
