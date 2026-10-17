export const BATCH_SCRIPT_TEMPLATE = String.raw`
import sys, os, json, hashlib, traceback, base64, scriptengine as script_engine
{ENSURE_PROJECT_OPEN_SNIPPET}
REQUEST = json.loads(base64.b64decode("{BATCH_REQUEST_B64}").decode("utf-8"))

def sha_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def sha_file(filename):
    digest = hashlib.sha256()
    with open(filename, "rb") as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()

def find_exact_object(project, full_path):
    parts = [part for part in full_path.replace("\\", "/").strip("/").split("/") if part]
    if not parts:
        raise ValueError("Empty IEC object path")
    # The application may be below a device / PLC Logic tree. Locate a unique
    # first segment, and traverse every remaining segment by direct child only.
    candidates = []
    roots = [project]
    if hasattr(project, "get_children"):
        roots.extend(list(project.get_children(True)))
    for candidate in roots:
        if unicode(candidate.get_name()) == parts[0]:
            candidates.append(candidate)
    if len(candidates) != 1:
        raise ValueError("First path segment %s matched %d objects; use an unambiguous path" % (parts[0], len(candidates)))
    current = candidates[0]
    for part in parts[1:]:
        children = list(current.get_children(False))
        matches = [child for child in children if unicode(child.get_name()) == part]
        if len(matches) != 1:
            raise ValueError("Path segment %s matched %d children in %s" % (part, len(matches), full_path))
        current = matches[0]
    return current

def read_section(obj, attr):
    if not hasattr(obj, attr):
        return None
    part = getattr(obj, attr)
    if part is None:
        return None
    if not hasattr(part, "text") or not hasattr(part, "replace"):
        raise RuntimeError("Section %s is not safely readable and writable" % attr)
    data = part.text
    return (unicode(data) if data is not None else u""), part

def summarize_before_after(before, after):
    details = {
        "beforeSha256": sha_text(before),
        "afterSha256": sha_text(after),
        "beforeLength": len(before),
        "afterLength": len(after),
        "changed": before != after
    }
    if REQUEST["mode"] == "preview":
        details["beforeCode"] = before
        details["afterCode"] = after
    return details

def collect_build_report(project):
    try:
        msg_system = system
    except NameError:
        msg_system = getattr(script_engine, "system", None)
    if msg_system is None or not hasattr(msg_system, "get_message_categories") or not hasattr(msg_system, "get_message_objects"):
        raise RuntimeError("CODESYS message store unavailable; refusing to confirm compilation")
    cats = list(msg_system.get_message_categories(False))
    if not cats:
        raise RuntimeError("CODESYS reported zero message categories")
    # Clear old messages before building so unrelated/stale errors are not counted.
    for cat in cats:
        try:
            msg_system.clear_messages(cat)
        except Exception as e:
            raise RuntimeError("Cannot clear messages before build: %s" % e)
    app = None
    try:
        app = project.active_application
    except Exception:
        pass
    if app is None or not hasattr(app, "build"):
        candidates = [obj for obj in project.get_children(True) if hasattr(obj, "is_application") and obj.is_application and hasattr(obj, "build")]
        if len(candidates) != 1:
            raise RuntimeError("Expected one application for compilation, found %d" % len(candidates))
        app = candidates[0]
    app.build()
    errors = 0
    warnings = 0
    messages = []
    failures = []
    for cat in cats:
        try:
            title = unicode(msg_system.get_message_category_description(cat))
        except Exception:
            title = unicode(cat)
        try:
            entries = list(msg_system.get_message_objects(cat))
        except Exception as e:
            failures.append("%s: %s" % (title, e))
            continue
        for item in entries:
            severity = unicode(getattr(item, "severity", "")).split(".")[-1]
            if severity not in ("Error", "FatalError", "Warning"):
                if severity not in ("Info", "Information", "Success", "Debug", "None"):
                    failures.append("Unrecognized build diagnostic severity %s in %s" % (severity, title))
                continue
            if len(messages) >= 3000:
                failures.append("Diagnostic output truncated at 3000 messages")
                break
            obj_name = u""
            position = u""
            try:
                if item.object is not None:
                    obj_name = unicode(item.object.get_name())
            except Exception:
                pass
            try:
                position = unicode(item.position_text or u"")
            except Exception:
                pass
            messages.append({
                "category": title, "severity": severity, "object": obj_name,
                "position": position, "text": unicode(item.text or u"")
            })
            if severity == "Warning":
                warnings += 1
            else:
                errors += 1
    return {
        "application": unicode(app.get_name()),
        "diagnostics_available": len(failures) == 0,
        "errors": errors, "warnings": warnings,
        "categories_scanned": len(cats),
        "message_read_failures": failures,
        "messages": messages
    }

result = {
    "mode": REQUEST["mode"],
    "project": unicode(PROJECT_FILE_PATH),
    "saved": False,
    "changes": [],
    "compile": None
}
phase = "preflight"
try:
    project = ensure_project_open(PROJECT_FILE_PATH)
    before_project_sha = sha_file(PROJECT_FILE_PATH)
    result["projectSha256"] = before_project_sha
    if REQUEST["mode"] == "apply" and before_project_sha.lower() != REQUEST["expectedProjectSha256"].lower():
        raise ValueError("Project file changed since preview; expected %s, got %s" % (REQUEST["expectedProjectSha256"], before_project_sha))

    # All requested objects and sections are resolved and checked before ANY mutation.
    # In particular an absent section is an error rather than silently skipped.
    resolved = []
    for change in REQUEST["changes"]:
        target = find_exact_object(project, change["path"])
        update = {"path": change["path"], "objectType": change["objectType"], "sections": {}}
        sections = []
        for section, attr, source_field, expected_field in [
                ("declaration", "textual_declaration", "declarationCode", "expectedDeclarationSha256"),
                ("implementation", "textual_implementation", "implementationCode", "expectedImplementationSha256")]:
            if source_field not in change:
                continue
            current = read_section(target, attr)
            if current is None:
                raise ValueError("%s has no %s section" % (change["path"], section))
            old_value, part = current
            proposed_value = unicode(change[source_field])
            details = summarize_before_after(old_value, proposed_value)
            if REQUEST["mode"] == "apply" and details["beforeSha256"].lower() != change[expected_field].lower():
                raise ValueError("Source changed for %s %s; expected %s, got %s" % (
                    change["path"], section, change[expected_field], details["beforeSha256"]))
            update["sections"][section] = details
            sections.append((part, proposed_value, section))
        resolved.append(sections)
        result["changes"].append(update)

    if REQUEST["mode"] == "apply":
        phase = "writing_in_memory"
        for changes in resolved:
            for part, content, _section in changes:
                part.replace(content)
        for changes in resolved:
            for part, content, section_name in changes:
                actual_text = unicode(part.text or u"")
                if actual_text != content:
                    raise RuntimeError("Readback verification failed for %s section" % section_name)
        phase = "compiling"
        if REQUEST["compileAfterApply"]:
            report = collect_build_report(project)
            result["compile"] = report
            if report["errors"] > 0 or not report["diagnostics_available"]:
                raise RuntimeError("Compilation had errors or incomplete diagnostics; changes not explicitly saved")
        phase = "saving"
        project.save()
        result["saved"] = True
        result["projectSha256After"] = sha_file(PROJECT_FILE_PATH)

    result["status"] = "preview" if REQUEST["mode"] == "preview" else "saved"
    print("MCP_BATCH_JSON:" + json.dumps(result, ensure_ascii=True))
    print("SCRIPT_SUCCESS: Batch operation completed.")
    sys.exit(0)
except Exception as e:
    result["status"] = "failed"
    result["failurePhase"] = phase
    result["error"] = unicode(e)
    # We intentionally DO NOT save or auto-restore on failure.
    # In-memory project changes and other side effects are NOT a transaction.
    print("MCP_BATCH_JSON:" + json.dumps(result, ensure_ascii=True))
    print("SCRIPT_ERROR: Batch operation failed: %s" % e)
    traceback.print_exc()
    sys.exit(1)

`;
