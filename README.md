# NetShare — complete multi-user version

This project keeps both existing modes:
1. **Direct P2P rooms:** users join with a room code and send files through WebRTC data channels.
2. **Server file library:** upload a file (maximum 100 MB), then share a link or download it later.

## Run locally

1. Install Python 3.10 or newer.
2. Open a terminal in this project folder.
3. Create and activate a virtual environment (optional but recommended).
4. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

5. Run:

   ```bash
   python app.py
   ```

6. Open `http://127.0.0.1:5000`.

For a phone on the same Wi-Fi, open the laptop's local IP address with port `5000`. Both devices must be able to reach the laptop.

## Deploy on Render

- Push all project files to your GitHub repository.
- Create a Render **Web Service** from that repository.
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn --worker-class gthread --workers 1 --threads 100 app:app`
- Set `NETSHARE_SECRET_KEY` to a long random secret (Render blueprint can generate it).
- Do not increase the number of Gunicorn workers: active room state is held in memory for this student demo.

The included `render.yaml` and `Procfile` provide the same start command.

## How the multi-user rooms work

- The signaling server sends only room membership and WebRTC offer/answer/ICE messages.
- Each browser creates a separate peer connection to every other browser in the room.
- A file is sent directly to each connected participant, in chunks, with a progress indicator.
- Maximum room size is 5 devices, including the creator.
- The 500 MB direct-transfer limit is a browser-demo limit, not a guarantee that every phone can hold that much data in memory.
- STUN servers are configured. Some networks block direct WebRTC connections; those networks may require a TURN relay service, which is not included.
- Room membership is temporary and resets when the server restarts. Room codes are not authentication, so only share them with people you trust.
- Server-uploaded files are stored on the app's filesystem. On Render, files may not survive a redeploy/restart unless you attach a persistent disk and configure storage accordingly.

## If Join does nothing

1. Open the website on both devices using the exact same Render URL.
2. Create a room on device A and copy the displayed code.
3. On device B, type the code and tap Join.
4. Check **Transfer activity** for a Socket.IO connection or room error.
5. If the page says the signaling server cannot be reached, inspect Render logs and confirm the service is running with the start command above.
6. If both devices join but direct connection fails, the network may require a TURN relay.

## Project structure

```text
NetShare_MultiUser_Complete/
├── app.py
├── requirements.txt
├── Procfile
├── render.yaml
├── README.md
├── templates/
│   ├── index.html
│   ├── share.html
│   └── 404.html
├── static/
│   ├── app.js
│   ├── direct-transfer.js
│   └── style.css
└── uploads/
```
