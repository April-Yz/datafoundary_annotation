# datafoundary_annotation

LeRobot 三视角任务名称标注工具。

当前版本：`2026-07-01-v13`

核心功能：

- 本地网页播放三视角视频进行人工复标
- 不显示原始 prompt/task，避免先入为主
- 必选机箱类型：大机箱 / 小机箱
- 选择任务物体与可选 action 前缀
- 记录 bad video、主视角严重偏移、跳变
- 支持 subtask 断点核对与修正
- 输出 `annotations.jsonl` 与 `annotations_latest.json`

使用说明：

- 标注员运行指南：[`ANNOTATOR_RUN_GUIDE.zh.md`](ANNOTATOR_RUN_GUIDE.zh.md)
- 标注规则：[`ANNOTATION_LABELING_RULES.zh.md`](ANNOTATION_LABELING_RULES.zh.md)
- 开发/构建说明：[`README.zh.md`](README.zh.md)

最小运行方式：

```bash
PACKAGE_DIR=/path/to/extracted_annotation_package
python3 "$PACKAGE_DIR/annotation_server.py" \
  --package-dir "$PACKAGE_DIR" \
  --host 127.0.0.1 \
  --port 18080 \
  --annotator your_name
```

浏览器打开：

```text
http://127.0.0.1:18080/
```

结果交付：

至少交回：

- `annotations.jsonl`
- `annotations_latest.json`

建议同时交回：

- `package_manifest.json`
- `items.jsonl`
