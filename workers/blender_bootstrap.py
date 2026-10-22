"""Load the existing Blenderwright addon into this disposable Blender process."""
import importlib.util
import json
import pathlib
import sys
import bpy

config = json.loads(pathlib.Path(sys.argv[sys.argv.index("--") + 1]).read_text(encoding="utf-8"))
if not config.get("resume"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
# Apply the declared delivery settings to the owned scene before existing tools run.
render = config.get("render", {})
scene = bpy.context.scene
width, height = int(render.get("width", 1280)), int(render.get("height", 720))
if config.get("phase") == "preview":
    scale = min(1.0, int(config.get("previewSize", 640)) / max(width, height))
    width, height = max(64, int(width * scale) // 2 * 2), max(64, int(height * scale) // 2 * 2)
scene.render.resolution_x, scene.render.resolution_y = width, height
scene.render.resolution_percentage = 100
scene.render.fps = int(render.get("fps", 24))
scene.frame_start = 1
scene.frame_end = 1 if config.get("phase") == "preview" else int(render.get("frames", 1))
addon = pathlib.Path(config["repo"]) / "addon"
spec = importlib.util.spec_from_file_location("local3d_blenderwright", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.register()
from local3d_blenderwright import server
server.start_server(host="127.0.0.1", port=config["port"])
print("LOCAL3D_BLENDER_READY", flush=True)
