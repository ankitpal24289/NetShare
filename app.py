from flask import Flask, render_template, request, redirect, url_for, flash, send_from_directory, abort
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
from pathlib import Path
from datetime import datetime
import json
import uuid
import os
import secrets
import string

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
DATA_FILE = BASE_DIR / "files.json"
UPLOAD_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.secret_key = os.environ.get("NETSHARE_SECRET_KEY", "change-this-development-secret")
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    max_http_buffer_size=1_000_000,
)

# In-memory room membership is intentionally used for this learning project.
# Keep one Gunicorn worker, because room state is not shared between workers.
MAX_ROOM_MEMBERS = 5
transfer_rooms = {}  # room_code -> list of Socket.IO session IDs


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
            return f"{int(size)} B" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def remove_socket_from_rooms(sid, announce=True):
    for room_code, members in list(transfer_rooms.items()):
        if sid not in members:
            continue
        members.remove(sid)
        leave_room(room_code, sid=sid)
        if announce:
            socketio.emit("transfer:peer-left", {"sid": sid, "room": room_code}, to=room_code)
        if not members:
            transfer_rooms.pop(room_code, None)


def valid_room_code(value):
    return isinstance(value, str) and 4 <= len(value) <= 12 and value.isalnum()


@app.route("/", methods=["GET"])
def index():
    records = load_records()
    records.sort(key=lambda item: item.get("uploaded_at", ""), reverse=True)
    for item in records:
        item["size_label"] = readable_size(item.get("size", 0))
    return render_template("index.html", files=records, max_room_members=MAX_ROOM_MEMBERS)


@app.route("/upload", methods=["POST"])
def upload():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        flash("Choose a file before uploading.", "error")
        return redirect(url_for("index"))
    original_name = secure_filename(uploaded.filename)
    if not original_name:
        flash("That filename is not supported. Please rename it and try again.", "error")
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
    record = next((item for item in load_records() if item.get("id") == file_id), None)
    if not record:
        abort(404)
    path = UPLOAD_DIR / record.get("stored_name", "")
    if not path.is_file() or path.parent.resolve() != UPLOAD_DIR.resolve():
        abort(404)
    return send_from_directory(UPLOAD_DIR, path.name, as_attachment=True, download_name=record["name"])


@app.route("/share/<file_id>", methods=["GET"])
def share(file_id):
    record = next((item for item in load_records() if item.get("id") == file_id), None)
    if not record:
        abort(404)
    return render_template("share.html", file=record, download_url=url_for("download", file_id=file_id, _external=True))


@socketio.on("transfer:join")
def transfer_join(data):
    data = data or {}
    room = str(data.get("room", "")).strip().upper()
    if not valid_room_code(room):
        emit("transfer:error", {"message": "Enter a valid room code (4–12 letters or numbers)."})
        return

    members = transfer_rooms.setdefault(room, [])
    if request.sid in members:
        emit("transfer:joined", {"room": room, "count": len(members), "peers": [sid for sid in members if sid != request.sid]})
        return
    if len(members) >= MAX_ROOM_MEMBERS:
        emit("transfer:error", {"message": f"This room is full. Maximum {MAX_ROOM_MEMBERS} participants are allowed."})
        return

    existing_members = list(members)
    members.append(request.sid)
    join_room(room)

    emit("transfer:joined", {
        "room": room,
        "count": len(members),
        "peers": existing_members,
        "max_members": MAX_ROOM_MEMBERS,
    })
    # Existing members initiate one connection to the newly joined member.
    socketio.emit("transfer:peer-joined", {
        "sid": request.sid,
        "room": room,
        "count": len(members),
    }, to=room, skip_sid=request.sid)


@socketio.on("transfer:leave")
def transfer_leave(data=None):
    remove_socket_from_rooms(request.sid, announce=True)
    emit("transfer:left", {"ok": True})


@socketio.on("transfer:signal")
def transfer_signal(data):
    data = data or {}
    room = str(data.get("room", "")).strip().upper()
    target = data.get("target")
    kind = data.get("kind")
    payload = data.get("payload")
    if kind not in {"offer", "answer", "ice"} or not isinstance(payload, dict):
        return
    members = transfer_rooms.get(room, [])
    if request.sid not in members or not isinstance(target, str) or target not in members or target == request.sid:
        return
    socketio.emit("transfer:signal", {
        "room": room,
        "from": request.sid,
        "kind": kind,
        "payload": payload,
    }, to=target)


@socketio.on("disconnect")
def transfer_disconnect():
    remove_socket_from_rooms(request.sid, announce=True)


@app.errorhandler(413)
def too_large(_error):
    flash("The file is too large. The maximum server-upload size is 100 MB.", "error")
    return redirect(url_for("index"))


@app.errorhandler(404)
def not_found(_error):
    return render_template("404.html"), 404


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False, allow_unsafe_werkzeug=True)
