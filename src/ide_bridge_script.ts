/**
 * A bounded, user-triggered bridge script for an already running CODESYS IDE.
 * Execute via Tools -> Scripting -> Execute Script File.
 *
 * No background thread, no UI-blocking poll loop, no arbitrary Python received
 * over IPC. The CODESYS Scripting Engine executes this on the IDE's own thread.
 * Python 2.7 / IronPython compatibility is intentional.
 */
export const IDE_BRIDGE_ONCE_PY = String.raw\`# -*- coding: utf-8 -*-
import os, sys, json, re, base64, hmac, hashlib, traceback, time
import scriptengine as se

BRIDGE_DIR = base64.b64decode("__BRIDGE_DIR_B64__").decode("utf-8")
REQUESTS = os.path.join(BRIDGE_DIR, "requests")
RESULTS = os.path.join(BRIDGE_DIR, "results")
KEY_PATH = os.path.join(BRIDGE_DIR, "secret.key")
MAX_COMMANDS = 10
MAX_BYTES = 1200000
ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
SHA_PATTERN = re.compile(r"^[a-f0-9]{64}$")

def normalized(value):
    return os.path.normcase(os.path.abspath(value))

def constant_time_equal(a, b):
    if len(a) != len(b):
        return False
    value = 0
    for x, y in zip(a, b):
        value |= ord(x) ^ ord(y)
    return value == 0

def sign(key, encoded):
    return hmac.new(key, encoded.encode("ascii"), hashlib.sha256).hexdigest()

def encode_envelope(key, request_id, data):
    raw = json.dumps(data, ensure_ascii=True, separators=(",", ":"))
    encoded = base64.b64encode(raw.encode("utf-8"))
    return {
        "version": 1, "id": request_id, "payload_b64": encoded,
        "signature": sign(key, encoded)
    }

def read_request(filename, key):
    if os.stat(filename).st_size > MAX_BYTES:
        raise ValueError("Request too large")
    with open(filename, "rb") as reader:
        envelope = json.load(reader)
    if envelope.get("version") != 1 or not isinstance(envelope.get("payload_b64"), basestring):
        raise ValueError("Invalid request envelope")
    request_id = os.path.basename(filename)[:-5]
    if envelope.get("id") != request_id or not ID_PATTERN.match(request_id):
        raise ValueError("Request id mismatch")
    encoded = str(envelope["payload_b64"])
    provided = str(envelope.get("signature", ""))
    if not constant_time_equal(sign(key, encoded), provided):
        raise ValueError("Request signature mismatch")
    return json.loads(base64.b64decode(encoded).decode("utf-8"))

def encode_hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def find_object(project, full_path):
    parts = full_path.replace("\\", "/").strip("/").split("/")
    if not parts or any(not p or p == "." or p == ".." for p in parts):
        raise ValueError("Invalid IEC object path")
    roots = [project]
    roots.extend(list(project.get_children(True)))
    first = [o for o in roots if unicode(o.get_name()) == parts[0]]
    if len(first) != 1:
        raise ValueError("Ambiguous or missing first path segment: %s" % parts[0])
    current = first[0]
    for part in parts[1:]:
        found = [o for o in current.get_children(False) if unicode(o.get_name()) == part]
        if len(found) != 1:
            raise ValueError("Ambiguous or missing segment %s at %s" % (part, full_path))
        current = found[0]
    return current

def read_section(obj, attr):
    if not hasattr(obj, attr):
        raise ValueError("Object has no %s section" % attr)
    section = getattr(obj, attr)
    if section is None or not hasattr(section, "text") or not hasattr(section, "replace"):
        raise ValueError("Object section %s is not textual and writable" % attr)
    text = section.text
    return section, (unicode(text) if text is not None else u"")

def process_request(request):
    if not isinstance(request, dict) or request.get("mode") not in ("preview", "apply"):
        raise ValueError("Unsupported bridge action")
    if request.get("expiresAt", 0) < time.time():
        raise ValueError("Bridge request expired; submit a new request")
    expected_project = request.get("projectFilePath", u"")
    if not isinstance(expected_project, basestring) or not expected_project:
        raise ValueError("Missing target project path")
    project = se.projects.primary
    if project is None or not getattr(project, "path", None):
        raise RuntimeError("No saved project is open in this IDE")
    actual_project = normalized(project.path)
    if actual_project != normalized(expected_project):
        raise RuntimeError("Wrong IDE project. Opened: %s; requested: %s" % (actual_project, expected_project))
    changes = request.get("changes")
    if not isinstance(changes, list) or not 1 <= len(changes) <= 20:
        raise ValueError("Expected 1-20 source changes")
    mode = request["mode"]
    planned = []
    summaries = []
    seen = set()
    # Preflight ALL objects and ALL sections before changing any in-memory code.
    for change in changes:
        path = change.get("path")
        if not isinstance(path, basestring) or not path:
            raise ValueError("Missing object path")
        key = path.lower()
        if key in seen:
            raise ValueError("Duplicate target: %s" % path)
        seen.add(key)
        target = find_object(project, path)
        planned_sections = []
        summary = {"path": path, "objectType": change.get("objectType"), "sections": {}}
        for label, attr, source, expected in [
            ("declaration", "textual_declaration", "declarationCode", "expectedDeclarationSha256"),
            ("implementation", "textual_implementation", "implementationCode", "expectedImplementationSha256")
        ]:
            if source not in change:
                continue
            section, before = read_section(target, attr)
            after = change[source]
            if not isinstance(after, basestring) or len(after) > 200000:
                raise ValueError("Invalid IEC source text")
            after = unicode(after)
            original_hash = encode_hash(before)
            if mode == "apply":
                expected_hash = change.get(expected, "")
                if not isinstance(expected_hash, basestring) or not SHA_PATTERN.match(expected_hash.lower()):
                    raise ValueError("Missing expected source hash for %s %s" % (path, label))
                if original_hash != expected_hash.lower():
                    raise ValueError("Stale source in open IDE for %s %s" % (path, label))
            item = {
                "beforeSha256": original_hash, "afterSha256": encode_hash(after),
                "changed": before != after, "beforeLength": len(before), "afterLength": len(after)
            }
            if mode == "preview":
                item["beforeCode"] = before
                item["afterCode"] = after
            summary["sections"][label] = item
            planned_sections.append((section, before, after))
        if not planned_sections:
            raise ValueError("Nothing to modify for %s" % path)
        planned.append(planned_sections)
        summaries.append(summary)
    if mode == "preview":
        return {"status": "preview", "project": actual_project, "changes": summaries, "saved": False}
    original_values = []
    try:
        for sections in planned:
            for section, before, after in sections:
                original_values.append((section, before))
                section.replace(after)
        for sections in planned:
            for section, before, after in sections:
                current = unicode(section.text or u"")
                if current != after:
                    raise RuntimeError("Readback mismatch after in-memory update")
    except Exception:
        # Attempt best-effort in-memory restore; do not silently assert rollback.
        restore_errors = []
        for section, before in reversed(original_values):
            try:
                section.replace(before)
            except Exception as restore_error:
                restore_errors.append(unicode(restore_error))
        if restore_errors:
            raise RuntimeError("Apply failed; in-memory rollback incomplete: %s" % u"; ".join(restore_errors))
        raise
    # Deliberately do NOT call project.save(), build(), login(), or PLC actions.
    # Users see modified unsaved code in the SAME IDE and choose whether to save.
    return {"status": "applied_unsaved", "project": actual_project,
            "changes": summaries, "saved": False,
            "message": "In-memory IEC changes applied; review and save in CODESYS IDE"}

def persist_result(key, req_id, value):
    encoded = encode_envelope(key, req_id, value)
    temp = os.path.join(RESULTS, req_id + ".tmp")
    final = os.path.join(RESULTS, req_id + ".json")
    with open(temp, "wb") as writer:
        writer.write(json.dumps(encoded, ensure_ascii=True))
    os.rename(temp, final)

def main():
    with open(KEY_PATH, "rb") as reader:
        key = reader.read()
    if len(key) != 32:
        raise RuntimeError("Bridge authentication secret is missing or invalid")
    files = sorted([name for name in os.listdir(REQUESTS)
                    if name.endswith(".json") and ID_PATTERN.match(name[:-5])])
    count = 0
    for name in files[:MAX_COMMANDS]:
        req_id = name[:-5]
        req_path = os.path.join(REQUESTS, name)
        try:
            req = read_request(req_path, key)
            data = {"ok": True, "result": process_request(req)}
        except Exception as e:
            data = {"ok": False, "error": unicode(e), "trace": traceback.format_exc()[-3000:]}
        try:
            persist_result(key, req_id, data)
            os.remove(req_path)
            count += 1
        except Exception as e:
            print("IDE bridge could not write result for %s: %s" % (req_id, e))
    print("CODESYS MCP IDE bridge processed %d request(s); %d pending initially." % (count, len(files)))

main()
\`;
