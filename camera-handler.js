const express = require("express");
const fs = require("fs");
const mqtt = require("mqtt");

const router = express.Router();

// ESP32 akan mengirim RAW JPEG → maka pakai express.raw()
router.use(express.raw({ type: "image/jpeg", limit: "20mb" }));

// MQTT client (optional untuk broadcast status update gambar)
const mqttClient = mqtt.connect("mqtt://localhost:1883");

// =================================================
// 🟩 1. ESP32: POST /uploadFrame → Simpan cam.jpg
// =================================================
router.post("/uploadFrame", async (req, res) => {
  try {
    const frame = req.body;

    if (!frame || frame.length === 0) {
      console.log("❌ ERROR: Frame kosong dari ESP32");
      return res.status(400).json({ error: "Frame kosong" });
    }

    // Simpan ke folder public
    fs.writeFileSync("./public/cam.jpg", frame);
    console.log("📸 Frame diterima & disimpan → public/cam.jpg");

    // OPSIONAL: Publish MQTT bahwa frame update
    mqttClient.publish("iot/camera/status", JSON.stringify({
      updated: true,
      timestamp: Date.now()
    }));

    // Respon ke ESP32
    return res.json({
      status: "ok",
      message: "Frame diterima dan disimpan"
    });

  } catch (err) {
    console.error("❌ ERROR uploadFrame:", err);
    return res.status(500).json({
      status: "error",
      message: "Gagal memproses frame"
    });
  }
});

// EXPORT ROUTER
module.exports = router;
