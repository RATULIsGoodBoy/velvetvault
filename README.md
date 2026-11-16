# ✨ VelvetVault

> **Ephemeral, self-hosted, privacy-first photo drop web application for Android (Termux) & Linux.**  
> Boot up on-demand for a set time (e.g. 15m, 30m, 1h), share a one-time link/QR code, receive spicy photos directly to your device with zero cloud storage, and auto-shutdown when time runs out.

---

## 📱 Android (Termux) Quick Start

You can run VelvetVault directly on your Android phone without needing a computer at all.

### 1. Install Prerequisites in Termux
Open **Termux** (installed from [F-Droid](https://f-droid.org/packages/com.termux/)) and run:

```bash
pkg update -y && pkg install git -y
git clone https://github.com/RATULIsGoodBoy/velvetvault.git
cd velvetvault && chmod +x setup-termux.sh && ./setup-termux.sh
```

### 2. Open the Vault
```bash
# Save directly into your Android phone's Pictures gallery (Unencrypted):
vault open 30m --no-encrypt

# Or keep open indefinitely:
vault open forever --no-encrypt

# Or open with military-grade AES-256 encryption at rest:
vault open 20m
```

### 3. What Happens Next:
1. An instant secure HTTPS link is created and **automatically copied to your phone's clipboard**.
2. An ASCII **QR code** is displayed in Termux (or on the Host Web Portal at `http://127.0.0.1:4040/portal`).
3. Send the link to your partner or let her scan the QR code.
4. When photos arrive:
   - Your phone **vibrates and shows an Android notification** (`termux-notification`).
   - Photos land **directly in your phone's `Pictures/Vault/` gallery folder**!
5. When the countdown reaches `00:00`, the server, tunnel, and session cleanly terminate.

---

## 💻 Linux PC Quick Start

```bash
git clone https://github.com/RATULIsGoodBoy/velvetvault.git
cd velvetvault && chmod +x setup-linux.sh && ./setup-linux.sh

# Open for 30 minutes:
vault open 30m ~/Pictures/Vault --no-encrypt

# Open Host Portal:
vault portal
```

---

## ⚡ Command Reference

| Command | Description |
| :--- | :--- |
| `vault open 20m` | Start a 20-minute drop window (auto-copied link + passkey) |
| `vault open 30m --no-encrypt` | Start session saving directly as normal `.jpg` / `.mp4` into Gallery |
| `vault open forever --no-encrypt` | Keep open until you manually close it |
| `vault open 1h ~/MyCustomFolder` | Save directly to any custom folder |
| `vault portal` | Open Host Control Portal in browser (`http://127.0.0.1:4040/portal`) |
| `vault export ~/Pictures/Saved` | Decrypt and export all `.enc` files into standard `.jpg` files |
| `vault status` | Check if a session is currently online and remaining time |
| `vault close` | Shut down the active vault and destroy the tunnel immediately |

---

## 📱 1-Tap Home Screen Widget (Termux:Widget)

If you install **Termux:Widget** from F-Droid:
1. Long-press on your phone's Home Screen and select **Widgets** $\rightarrow$ **Termux:Widget**.
2. Choose **`Open_Vault_20m.sh`**.
3. Now you have a button on your home screen to boot up your vault with **one single tap**!

---

## 🛡️ Privacy & Security Features

* **Zero Cloud Storage**: Nothing touches AWS, Google Cloud, or third-party storage. Files flow strictly point-to-point into your local device.
* **Auto-EXIF Scrubbing**: Automatically strips GPS coordinates, camera models, and location metadata from incoming photos before saving to disk.
* **Optional AES-256-GCM Encryption**: Encrypts files at rest with a Master Passkey so even root scanners cannot view them without your password.
* **Multi-Tier Zero-Config Tunneling**: Automatic fallback between Cloudflare Quick Tunnel, Pinggy SSH, and Localhost.run SSH.
* **Anti-Caching Headers**: Transmits `Cache-Control: no-store` and `Clear-Site-Data: "cache"` so her phone browser discards cached previews on tab close.
* **Girlfriend-Friendly Mobile Uploader**: Direct camera shutter button, multi-file gallery picker, and a tap-to-blur privacy toggle (`🙈 Privacy Blur`).

---

## 📄 License
MIT License. Created by [RATULIsGoodBoy](https://github.com/RATULIsGoodBoy).
