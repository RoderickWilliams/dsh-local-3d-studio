"""Thin adapter around Tencent's existing pipelines; no model implementation."""
import json
import os
import pathlib
import sys

request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
repo = pathlib.Path(request["repo"])
os.chdir(repo)
sys.path[:0] = [str(repo), str(repo / "hy3dshape"), str(repo / "hy3dpaint")]
from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
    request["weights"], subfolder="hunyuan3d-dit-v2-1"
)
mesh = pipeline(image=request["input"])[0]
target = pathlib.Path(request["output"])
mesh.export(str(target))
if request.get("paint"):
    # 上游 PBR 管线仍需其安装说明要求的光栅化扩展与本地辅助权重。
    from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig
    paint = Hunyuan3DPaintPipeline(Hunyuan3DPaintConfig(max_num_view=6, resolution=512))
    generated = paint(str(target), image_path=request["input"])
    if hasattr(generated, "export"):
        generated.export(str(target))
    elif isinstance(generated, (str, pathlib.Path)) and pathlib.Path(generated).is_file():
        import shutil
        shutil.copyfile(generated, target)
    else:
        raise RuntimeError("上游贴图管线没有返回可导出的模型；未把未贴图模型冒充 PBR 成果。")
print(str(target), flush=True)
