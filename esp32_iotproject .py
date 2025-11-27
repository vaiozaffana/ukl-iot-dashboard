from machine import Pin, ADC
import network, time, json
from umqtt.simple import MQTTClient
import dht

# ============================
# --- PIN DEFINISI ---
# ============================
LAMP = Pin(5, Pin.OUT)
FAN = Pin(18, Pin.OUT)
BUZZER = Pin(19, Pin.OUT)
 
DHT11_PIN = Pin(15, Pin.IN)
MQ135_PIN = ADC(Pin(34))
LDR_PIN = ADC(Pin(32))

# --- Konfigurasi ADC ---
for pin in [MQ135_PIN, LDR_PIN]:
    pin.atten(ADC.ATTN_11DB)
    pin.width(ADC.WIDTH_12BIT)

dht11 = dht.DHT11(DHT11_PIN)

# ============================
# --- KONFIGURASI WIFI & MQTT ---
# ============================
SSID = "werrr"
PASSWORD = "anjayani"
MQTT_SERVER = "172.29.49.95"
CLIENT_ID = "ESP32Client"

client = None
manual_lamp = False
manual_fan = False
last_manual_lamp = 0
last_manual_fan = 0
manual_timeout = 300000  # 5 menit (300.000 ms)

# ============================
# --- WIFI CONNECT ---
# ============================
def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        print("🔌 Menghubungkan WiFi...")
        wlan.connect(SSID, PASSWORD)
        while not wlan.isconnected():
            time.sleep(0.5)
    print("✅ WiFi Terkoneksi:", wlan.ifconfig())

# ============================
# --- CALLBACK MQTT ---
# ============================
def sub_cb(topic, msg):
    global manual_lamp, manual_fan, last_manual_lamp, last_manual_fan
    print("📩 Pesan diterima:", topic, msg)
    try:
        data = json.loads(msg)

        # --- LAMPU ---
        if topic == b"iot/lamp/cmd":
            manual_lamp = True
            last_manual_lamp = time.ticks_ms()  # catat waktu terakhir kontrol manual
            if data["status"] == "ON":
                LAMP.value(0)
                client.publish(b"iot/lamp/status", json.dumps({"status": "ON"}))
            else:
                LAMP.value(1)
                client.publish(b"iot/lamp/status", json.dumps({"status": "OFF"}))

        # --- KIPAS ---
        elif topic == b"iot/fan/cmd":
            manual_fan = True
            last_manual_fan = time.ticks_ms()
            if data["status"] == "ON":
                FAN.value(0)
                client.publish(b"iot/fan/status", json.dumps({"status": "ON"}))
            else:
                FAN.value(1)
                client.publish(b"iot/fan/status", json.dumps({"status": "OFF"}))

    except Exception as e:
        print("❌ Error callback:", e)

# ============================
# --- MQTT CONNECT ---
# ============================
def connect_mqtt():
    global client
    while True:
        try:
            client = MQTTClient(CLIENT_ID, MQTT_SERVER)
            client.set_callback(sub_cb)
            client.connect()
            client.subscribe(b"iot/lamp/cmd")
            client.subscribe(b"iot/fan/cmd")
            print("✅ MQTT Terhubung ke:", MQTT_SERVER)
            break
        except Exception as e:
            print("❌ MQTT gagal:", e)
            time.sleep(5)

# ============================
# --- INISIALISASI ---
# ============================
connect_wifi()
connect_mqtt()

for device in [LAMP, FAN, BUZZER]:
    device.value(1)

last_sensor = time.ticks_ms()
interval_sensor = 5000  # kirim data tiap 5 detik

# ============================
# --- LOOP UTAMA ---
# ============================
while True:
    try:
        client.check_msg()

        # 🔁 Reset mode manual jika sudah lewat batas waktu
        now = time.ticks_ms()
        if manual_lamp and time.ticks_diff(now, last_manual_lamp) > manual_timeout:
            manual_lamp = False
            print("⏳ Mode lampu kembali ke otomatis")

        if manual_fan and time.ticks_diff(now, last_manual_fan) > manual_timeout:
            manual_fan = False
            print("⏳ Mode kipas kembali ke otomatis")

        if time.ticks_diff(now, last_sensor) > interval_sensor:
            # --- BACA SENSOR DHT11 ---
            try:
                dht11.measure()
                suhu = dht11.temperature()
                kelembapan = dht11.humidity()
            except Exception as e:
                print("⚠️ DHT11 Error:", e)
                suhu, kelembapan = None, None

            # --- BACA MQ135 ---
            gas_raw = MQ135_PIN.read()
            gas_ppm = {
                "co": round((gas_raw / 4095) * 1000, 2),
                "co2": round((gas_raw / 4095) * 800, 2),
                "nh4": round((gas_raw / 4095) * 500, 2),
                "Alcohol": round((gas_raw / 4095) * 300, 2),
                "Tolueno": round((gas_raw / 4095) * 200, 2),
                "Aceton": round((gas_raw / 4095) * 100, 2)
            }

            # --- BACA LDR ---
            ldr_value = LDR_PIN.read()

            # --- KONTROL LAMPU ---
            if not manual_lamp:
                if ldr_value > 2000:
                    LAMP.value(0)
                    lamp_status = "ON"
                else:
                    LAMP.value(1)
                    lamp_status = "OFF"
                client.publish(b"iot/lamp/status", json.dumps({"status": lamp_status}))
            else:
                lamp_status = "MANUAL"

            # --- KONTROL KIPAS ---
            if not manual_fan and suhu is not None:
                if suhu > 35:
                    FAN.value(0)
                    fan_status = "ON"
                else:
                    FAN.value(1)
                    fan_status = "OFF"
                client.publish(b"iot/fan/status", json.dumps({"status": fan_status}))
            elif manual_fan:
                fan_status = "MANUAL"
            else:
                fan_status = "ERROR"

            # --- KONTROL BUZZER ---
            if gas_ppm["co"] > 600 or gas_ppm["co2"] > 500:
                BUZZER.value(0)
                buzzer_status = "ON"
            else:
                BUZZER.value(1)
                buzzer_status = "OFF"

            # --- PUBLISH DATA ---
            data = {
                "suhu": round(suhu, 1) if suhu is not None else None,
                "kelembapan": round(kelembapan, 1) if kelembapan is not None else None,
                "gas": gas_ppm,
                "ldr": ldr_value,
                "lamp": lamp_status,
                "fan": fan_status,
                "buzzer": buzzer_status
            }

            client.publish(b"iot/monitoring", json.dumps(data))
            print("📤 Data Dikirim:", data)

            last_sensor = now

        time.sleep_ms(100)

    except Exception as e:
        print("⚠️ Loop error:", e)
        time.sleep(2)
        connect_mqtt()
