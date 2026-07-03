import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ service: "kokromoti-api", status: "ok", operator: "AIEI" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`kokromoti-api listening on :${PORT}`));
