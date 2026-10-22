"""One explicitly approved offline check batch. No installation or inference."""
import ast
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile
import uuid

root = pathlib.Path(__file__).resolve().parents[1]
results = []

def command(label, argv):
    completed = subprocess.run(argv, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
    results.append({"check": label, "passed": completed.returncode == 0,
                    "output": (completed.stdout + completed.stderr)[-24000:]})

node = shutil.which("node")
if node:
    command("offline unit tests (once)", [node, "--test", "tests/core.test.mjs"])
    for file in sorted([root / "index.mjs", *list((root / "src").glob("*.mjs")), *list((root / "tests").glob("*.mjs"))]):
        command("JS syntax: " + file.relative_to(root).as_posix(), [node, "--check", str(file)])
else:
    results.append({"check": "Node availability", "passed": False, "output": "Node is not installed; nothing was installed automatically."})

for file in sorted([*list((root / "workers").glob("*.py")), *list((root / "scripts").glob("*.py"))]):
    try:
        ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
        results.append({"check": "Python syntax: " + file.relative_to(root).as_posix(), "passed": True})
    except Exception as error:
        results.append({"check": "Python syntax: " + str(file), "passed": False, "output": str(error)})

try:
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    expected = {"package/package.json", "package/index.mjs", "package/cordis.patch.yml", "package/recipes/orchestrator.md"}
    package = root / "dist" / f'{manifest["name"]}-{manifest["version"]}.tgz'
    with tarfile.open(package, "r:gz") as archive:
        names = set(archive.getnames())
    if not expected.issubset(names) or any("/.reference/" in name or "/node_modules/" in name for name in names):
        raise ValueError("Install archive has missing required files or contains reference/dependency directories.")
    if manifest.get("dsh", {}).get("bundle", {}).get("patch") != "./cordis.patch.yml":
        raise ValueError("Missing DSH bundle manifest.")
    results.append({"check": "DSH install archive and manifest", "passed": True, "files": len(names)})
except Exception as error:
    results.append({"check": "DSH install archive and manifest", "passed": False, "output": str(error)})

report = {"scope": "offline unit tests, JS/Python syntax, archive structure; no live integrations", "results": results,
          "passed": all(item["passed"] for item in results)}
target = root / "dist" / f"offline-check-{uuid.uuid4().hex[:8]}.json"
target.parent.mkdir(exist_ok=True)
target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=True, indent=2))
print(str(target))
sys.exit(0 if report["passed"] else 1)
