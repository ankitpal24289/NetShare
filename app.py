from flask import Flask, render_template, request, redirect, url_for, flash, send_from_directory, abort
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
from pathlib import Path
from datetime import datetime
import json
import uuid
import os

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
DATA_FILE = BASE_DIR / "files.json"
UPLOAD_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.secret_key = os.environ.get("NETSHARE_SECRET_KEY", "change-this-development-secret")
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# In-memory signaling rooms. Actual file bytes never pass through these handlers.
transfer_rooms = {}


def load_records():
    try:
        with DATA_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_records(records):
    temp_file = DATA_FILE.with_suffix(".tmp")
    with temp_file.open("w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
    temp_file.replace(DATA_FILE)


def readable_size(num_bytes):
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} GB"


@app.route("/", methods=["GET"])
def index():
    records = load_records()
    records.sort(key=lambda item: item.get("uploaded_at", ""), reverse=True)
    for item in records:
        item["size_label"] = readable_size(item.get("size", 0))
    return render_template("index.html", files=records)


@app.route("/upload", methods=["POST"])
def upload():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        flash("Choose a file before uploading.", "error")
        return redirect(url_for("index"))
    original_name = secure_filename(uploaded.filename)
    if not original_name:
        flash("That filename is not supported. Please rename the file and try again.", "error")
        return redirect(url_for("index"))
    file_id = uuid.uuid4().hex[:12]
    stored_name = f"{file_id}_{original_name}"
    destination = UPLOAD_DIR / stored_name
    uploaded.save(destination)
    records = load_records()
    records.append({
        "id": file_id,
        "name": original_name,
        "stored_name": stored_name,
        "size": destination.stat().st_size,
        "uploaded_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    })
    save_records(records)
    flash(f'"{original_name}" uploaded successfully.', "success")
    return redirect(url_for("index"))


@app.route("/download/<file_id>", methods=["GET"])
def download(file_id):
    records = load_records()
    record = next((item for item in records if item.get("id") == file_id), None)
    if not record:
        abort(404)
    path = UPLOAD_DIR / record.get("stored_name", "")
    if not path.is_file() or path.parent.resolve() != UPLOAD_DIR.resolve():
        abort(404)
    return send_from_directory(UPLOAD_DIR, path.name, as_attachment=True, download_name=record["name"])


@app.route("/share/<file_id>", methods=["GET"])
def share(file_id):
    records = load_records()
    record = next((item for item in records if item.get("id") == file_id), None)
    if not record:
        abort(404)
    return render_template("share.html", file=record, download_url=url_for("download", file_id=file_id, _external=True))


@socketio.on("transfer:join")
def transfer_join(data):
    room = str((data or {}).get("room", "")).strip().upper()
    if not room or len(room) > 12 or not room.isalnum():
        emit("transfer:error", {"message": "Enter a valid room code."})
        return
    members = transfer_rooms.setdefault(room, [])
    if request.sid not in members and len(members) >= 2:
        emit("transfer:error", {"message": "This room already has two participants. Create a new room."})
        return
    if request.sid not in members:
        members.append(request.sid)
    join_room(room)
    emit("transfer:joined", {"room": room, "count": len(members), "waiting": len(members) < 2})
    if len(members) == 2:
        initiator_sid = members[0]
        for sid in list(members):
            socketio.emit("transfer:room-ready", {
                "room": room,
                "count": 2,
                "initiator": sid == initiator_sid,
            }, to=sid)


@socketio.on("transfer:leave")
def transfer_leave(data=None):
    sid = request.sid
    for room, members in list(transfer_rooms.items()):
        if sid in members:
            members.remove(sid)
            leave_room(room)
            socketio.emit("transfer:peer-left", {"room": room}, to=room)
            if not members:
                transfer_rooms.pop(room, None)
            break


@socketio.on("transfer:signal")
def transfer_signal(data):
    data = data or {}
    room = str(data.get("room", "")).strip().upper()
    kind = data.get("kind")
    payload = data.get("payload")
    if kind not in {"offer", "answer", "ice"} or not isinstance(payload, dict):
        return
    members = transfer_rooms.get(room, [])
    if request.sid not in members:
        return
    # Signal data only (SDP/ICE); file contents use the WebRTC data channel.
    for sid in members:
        if sid != request.sid:
            socketio.emit("transfer:signal", {"kind": kind, "payload": payload}, to=sid)


@socketio.on("disconnect")
def transfer_disconnect():
    sid = request.sid
    for room, members in list(transfer_rooms.items()):
        if sid in members:
            members.remove(sid)
            socketio.emit("transfer:peer-left", {"room": room}, to=room)
            if not members:
                transfer_rooms.pop(room, None)


@app.errorhandler(413)
def too_large(_error):
    flash("The file is too large. The maximum upload size is 100 MB.", "error")
    return redirect(url_for("index"))


@app.errorhandler(404)
def not_found(_error):
    return render_template("404.html"), 404


if __name__ == "__main__":
    # Use only on a trusted private network for demonstrations.
    socketio.run(app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True)
