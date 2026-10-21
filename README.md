# NetShare — Web-Based File Sharing + Direct P2P Transfer

A Networking and Web Technologies mini-project built with Python Flask, Flask-SocketIO, HTML, CSS, and JavaScript. It provides two different ways to share files:

1. **Share by link (server-based):** upload a file to the Flask server and share a download link.
2. **Direct Transfer (WebRTC):** create a room code on one device and join it from another. Once the WebRTC data channel connects, file bytes travel between the browsers rather than through the Flask application server. The server only relays connection signaling messages.

## Requirements
- Python 3.10 or newer
- pip
- Internet access in the browser for the Socket.IO client CDN on first page load (or download and serve that client locally if your demo must be fully offline)

## Run on Windows
1. Extract `NetShare_Web_App.zip` and open the folder in VS Code.
2. In the terminal, run:

   ```powershell
   py -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   python app.py
   ```

3. Open `http://127.0.0.1:5000` on the laptop.

## Test direct transfer between laptop and phone
1. Connect both devices to the same Wi-Fi network.
2. Keep the Flask app running on your laptop.
3. Run `ipconfig` in Windows Command Prompt and find the laptop's IPv4 address (example: `192.168.1.8`).
4. On the phone, open `http://YOUR-PC-IP:5000`, replacing the example with the actual IP address.
5. On the laptop, scroll to **Direct Transfer** and click **Create room**.
6. Copy the six-character room code and enter it on the phone, then click **Join**.
7. Wait for the status to say the direct connection is established. Select a file on either device and click **Send directly**. The receiver gets a **Save file** link.
8. Try a small file first (photo or PDF). Direct transfer supports files up to 500 MB in this demo, depending on device memory and browser capability.

If the phone cannot reach the app, check that both devices are on the same Wi-Fi, the laptop IP is correct, and Windows Firewall permits Python on the private network. Some guest Wi-Fi networks isolate connected devices. For devices on different networks, a TURN relay may be needed; this starter app uses public STUN servers and does not configure TURN.

## Project structure
```text
NetShare_Web_App/
├── app.py                      # Flask routes + Socket.IO signaling
├── requirements.txt
├── README.md
├── files.json                  # created after first server-based upload
├── uploads/                    # files uploaded via Share by link
├── templates/
│   ├── index.html
│   ├── share.html
│   └── 404.html
└── static/
    ├── style.css
    ├── app.js
    └── direct-transfer.js      # WebRTC DataChannel transfer logic
```

## NWT concepts demonstrated
- Client–server architecture and HTTP requests
- TCP/IP networking and local-area network access
- Flask web server and Socket.IO signaling
- WebRTC peer-to-peer data channel for direct file transfer
- STUN-assisted connection discovery
- HTML, CSS, JavaScript and browser events

## Important limitations / safety
- This is an educational demonstration, not a production file-sharing service.
- There are no accounts, identity checks, or room-code authentication. Anyone who learns a room code may attempt to join; share codes privately and use a trusted network.
- Room state is stored in server memory and resets when the app restarts.
- Direct transfer requires both browsers to stay open and connected. The browser may keep file data in memory until it is saved. Start with small files.
- A direct WebRTC path is not guaranteed on every network. For broader internet connectivity, configure a trusted TURN service.
- The Socket.IO client is loaded from a CDN. The first page load requires internet access unless you bundle that client locally.
- The server-based upload feature has no login/access control. Do not expose it to the public internet or use it for confidential files.
- WebRTC encrypts its transport, but this app does not provide end-to-end identity verification or a secure pairing protocol.
