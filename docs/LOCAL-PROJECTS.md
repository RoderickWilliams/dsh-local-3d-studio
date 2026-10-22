# 接入更适合自己的本地项目

优先把项目目录加入 `preferredProjects`。Blenderwright、TripoSR、Hunyuan3D 2.1、ComfyUI 可以通过已知源码标记识别；不会因此自动执行代码。

其他项目在仓库根目录放置 `local-3d.adapter.json`，声明能力、真实入口和输出契约。无需改本插件源码。先阅读项目 README 确认实际 CLI，不能把下面的示意入口直接当作该项目已有命令。

```json
{
  "schemaVersion": 1,
  "localOnly": true,
  "id": "my-local-reconstructor",
  "displayName": "我已安装的重建项目",
  "kind": "command",
  "capabilities": ["image-to-3d", "video-to-3d"],
  "minVramMiB": 8192,
  "command": ".venv/Scripts/python.exe",
  "args": ["实际入口.py", "--input", "{input}", "--output", "{output}"],
  "outputs": [{"type": "model", "path": "mesh.glb"}]
}
```

`command` 是该项目内相对入口或绝对可执行路径；使用 `{python}` 时取插件配置的 aiPython。参数逐项传给进程，不拼成 shell 字符串。`outputs.path` 必须是本次输出目录内的相对路径。`capabilities` 让 DeepSeek 根据任务选择；`minVramMiB` 只表示该项目真实配置的要求，不能随意填写。

可用变量：`{input}`、`{output}`、`{prompt}`、`{negativePrompt}`、`{seed}`、`{width}`、`{height}`。传给 `studio_plan` 的 adapter 步骤应先用项目占位符映射真实输入和输出目录。

ComfyUI 用已有的 API 格式工作流：

```json
{
  "schemaVersion": 1,
  "localOnly": true,
  "id": "my-concept-workflow",
  "kind": "comfyui",
  "capabilities": ["text-to-image"],
  "workflow": "workflows/concept-api.json",
  "outputs": [{"type": "image", "path": "concept.png"}]
}
```

工作流节点参数中可以使用上述变量。需要图片时使用 `{inputImage}`，插件先把项目内的参考文件发给**本机** ComfyUI，再用其回执替换此变量。必须具备能返回 images / gifs / files 的输出节点；特殊三维节点的自定义输出结构，可通过 command 类型调用该项目已有导出脚本。

一个擅长生成视频的项目只能声明其实际能力。输出一段二维视频，不代表它也能提供网格、贴图、骨骼和三维动画工程。插件最终三维交付仍需现成工具生成真实工程与模型文件。

`localOnly: true` 是项目所有者对入口的明确声明。插件拒绝已知的云端生成节点与认证字段；它不审计任意第三方项目内部实现，因此只登记你确认能纯本地运行的入口。
