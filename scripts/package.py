"""Create installable local archives; does not execute tests or third-party code."""
import json
import pathlib
import tarfile
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
dist = root / "dist"
dist.mkdir(exist_ok=True)
name = f'{manifest["name"]}-{manifest["version"]}'
entries = [root / "package.json"]
for item in manifest["files"]:
    file = root / item
    if file.is_dir():
        entries.extend(p for p in file.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    elif file.is_file():
        entries.append(file)
entries = sorted(set(entries))
with tarfile.open(dist / f"{name}.tgz", "w:gz") as archive:
    for file in entries:
        archive.add(file, arcname="package/" + file.relative_to(root).as_posix(), recursive=False)
with zipfile.ZipFile(dist / f"{name}.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for file in entries:
        archive.write(file, arcname=name + "/" + file.relative_to(root).as_posix())
print(str(dist / f"{name}.tgz"))
print(str(dist / f"{name}.zip"))
