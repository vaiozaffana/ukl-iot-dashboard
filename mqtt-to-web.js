const mqtt = require("mqtt");
const express = require("express");
const mysql = require("mysql2");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const upload = multer();
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json({ limit: "10mb" }));

// === ROUTER UNTUK FRAME DARI ESP32-CAM ===
const cameraHandler = require("./camera-handler");
app.use("/", cameraHandler);

// === PORT EXPRESS ===
const port = 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// gunakan model flash free
const model = genAI.getGenerativeModel({
  model: "models/gemini-2.5-flash"
});

// === VARIABEL PENYIMPAN PAYLOAD TERBARU ===
let latestData = {};

// === KONEKSI MQTT BROKER ===
const client = mqtt.connect("mqtt://localhost:1883");

// === KONEKSI DATABASE MYSQL ===
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "iot_dashboard",
});

db.connect((err) => {
  if (err) {
    console.error("Gagal terhubung ke database:", err);
  } else {
    console.log("✔ Terhubung ke database MySQL");
  }
});

// === MQTT CONNECT ===
client.on("connect", () => {
  console.log("✔ Terhubung ke broker MQTT");

  client.subscribe("iot/monitoring", (err) => {
    if (!err) console.log("✔ Subscribe ke iot/monitoring");
  });
});

app.get("/checkFace", async (req, res) => {
  try {
    const ownerPath = path.join(__dirname, "public", "owner.jpeg");
    const camPath   = path.join(__dirname, "public", "cam.jpg");

    const ownerBase64 = fs.readFileSync(ownerPath).toString("base64");
    const camBase64   = fs.readFileSync(camPath).toString("base64");

    const ownerImg = {
      inlineData: {
        mimeType: "image/jpeg",
        data: ownerBase64,
      },
    };

    const camImg = {
      inlineData: {
        mimeType: "image/jpeg",
        data: camBase64,
      },
    };

    const prompt = `
      Compare these two faces and respond only in JSON:
      {
        "same_person": true/false,
        "confidence": 0.0-1.0
      }
      If unsure, set same_person to false.
    `;

    const result = await model.generateContent([
      {
        role: "user",
        parts: [
          { text: prompt },
          ownerImg,
          camImg
        ],
      },
    ]);

    const json = JSON.parse(result.response.text());

    client.publish("iot/face/status", JSON.stringify({
      status: json.same_person ? "authorized" : "unauthorized",
      confidence: json.confidence,
    }));

    res.json(json);

  } catch (err) {
    console.error("Face Check Error:", err);
    res.status(500).json({ error: err.message });
  }
});

async function autoFaceDetection() {
  try {
    const camPath = path.join(__dirname, "public", "cam.jpg");
    const ownerPath = path.join(__dirname, "public", "owner.jpeg");

    if (!fs.existsSync(camPath)) return;
    if (!fs.existsSync(ownerPath)) return;

    const camBase64 = fs.readFileSync(camPath).toString("base64");
    const ownerBase64 = fs.readFileSync(ownerPath).toString("base64");

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `
              Compare the two faces.
              Respond only with pure JSON:
              {
                "same_person": true/false,
                "confidence": number
              }`
            },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: ownerBase64
              }
            },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: camBase64
              }
            }
          ]
        }
      ]
    });

    let json;
    try {
      json = JSON.parse(result.response.text());
    } catch {
      json = { same_person: false, confidence: 0 };
    }

    console.log("🤖 AUTO FACE RESULT:", json);

    client.publish(
      "iot/face/status",
      JSON.stringify({
        status: json.same_person ? "authorized" : "unauthorized",
        confidence: json.confidence
      })
    );

  } catch (err) {
    console.error("❌ Auto-face error:", err.message);
  }
}
// Jalankan setiap 2 detik
setInterval(autoFaceDetection, 2000);


// === MENERIMA DATA MQTT ===
client.on("message", (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    latestData = payload;

    // Ambil sensor
    const suhu = payload.suhu ?? null;
    const kelembapan = payload.kelembapan ?? null;

    const gas = payload.gas || {};
    const co = gas.co ?? null;
    const co2 = gas.co2 ?? null;
    const nh4 = gas.nh4 ?? null;

    // SQL INSERT
    const sql = `
      INSERT INTO datasensor (suhu, kelembapan, co, co2, nh4, waktu)
      VALUES (?, ?, ?, ?, ?, NOW())
    `;

    db.query(sql, [suhu, kelembapan, co, co2, nh4], (err, result) => {
      if (err) {
        console.error("❌ Gagal menyimpan ke database:", err);
      } else {
        console.log("✔ Data sensor disimpan (ID:", result.insertId, ")");
      }
    });

  } catch (e) {
    console.error("❌ Gagal parsing data MQTT:", e);
  }
});

// === REST API UNTUK AMBIL DATA TERBARU ===
app.get("/data", (req, res) => {
  db.query("SELECT * FROM datasensor ORDER BY waktu DESC LIMIT 1", (err, results) => {
    if (err) return res.status(500).json({ error: "Gagal mengambil data" });
    res.json(results[0] || {});
  });
});

// === JALANKAN SERVER ===
app.listen(port, () => {
  console.log(`🚀 Server berjalan di http://localhost:${port}`);
});
