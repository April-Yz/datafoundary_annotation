# 任务名称标注工具

这个工具用于从已有 LeRobot clean final 中抽取三视角视频，让标注员只看视频重新确认任务名称。

设计目标：

- 不显示原始 prompt / task，避免先入为主。
- 每条必须先选择机箱类型：大机箱 / 小机箱；没有默认值。
- 默认只需要选机箱类型 + 物体并按 Enter。
- 动作前缀是可选项，默认 `none`，适合当前 `cpu / ram / disk / gpu` 这类“完整任务名”口径。
- `unknown` 不作为物体选项；看不清时勾选 `bad video`，或选 `other_object`。
- 输出 `annotations.jsonl` 和 `annotations_latest.json`，方便按 timestamp 回写或交叉验证。

## 安装 / 运行环境要求

给标注员发包时，优先附带以下两份文档：

- `ANNOTATOR_RUN_GUIDE.zh.md`：如何解压、启动服务、端口转发、交付结果
- `ANNOTATION_LABELING_RULES.zh.md`：如何选择 object/action、B/C/D、subtask 断点和注意事项

标注员机器只需要浏览器；数据所在服务器运行轻量 Python 服务。

服务器要求：

- Linux/macOS 均可，推荐 Python 3.10+；cartin1 当前用系统 `/usr/bin/python3` 即可。
- `ffmpeg` 和 `ffprobe`：用于构建 package 时生成开始/中间/结束预览图。
- 浏览器能播放 H.264 MP4。
- 如果视频和 package 在同一块文件系统，推荐 `--copy-mode hardlink`，几乎不额外占视频空间；跨盘会自动或需要改用 `copy`。
- 远程访问时需要 SSH 端口转发，例如：

```bash
ssh -o ExitOnForwardFailure=yes -N -L 8002:127.0.0.1:18080 cartin1-wenkai
```

当前 test server：

```bash
/usr/bin/python3 /home/wenkai/hdd/lerobot_final_collected_20260628/annotation_test_20260630/annotation_server.py \
  --package-dir /home/wenkai/hdd/lerobot_final_collected_20260628/annotation_test_20260630 \
  --host 127.0.0.1 --port 18080 --annotator test
```

注意：`annotation_server.py` 已支持 HTTP Range (`206 Partial Content`)，否则浏览器可能无法拖动 MP4 进度条。

## 标签映射

动作前缀：

- `0 none`：默认，无前缀，输出直接等于物体名
- `1 pick_up`
- `2 insert`
- `3 pick_up_and_insert`
- `9 other_action`

物体：

- `1 cpu`
- `2 disk`
- `3 gpu`
- `4 ram`
- `5 ram2`
- `8 自定义 object`

输出规则：

- `chassis_type` 必填：`large_case` 或 `small_case`
- `chassis_label`：`大机箱` 或 `小机箱`
- action 为 `none`：`canonical_label = object`
- action 非 `none`：`canonical_label = action + "_" + object`

质量标记：

- `B bad_video`：看不清 / 视频坏
- `C main_view_severe_offset`：主视角严重偏移
- `D has_jump`：存在明显跳变

## Subtask 分段

标准 subtask 来自 `data_foundary/vqa_hl_generation_pipeline/config.yaml`：

- `cpu`：6 段
- `disk`：4 段
- `gpu`：4 段
- `ram`：5 段
- `ram2`：复用 `ram` 的 5 段模板，但最终 object 仍保存为 `ram2`

如果 action 前缀为 `none`，表示这是一个完整任务标签：

- package builder 会读取源 LeRobot parquet 的逐帧 `subtask` 列，预加载已有分段。
- 如果源分段数量与当前 object 的标准模板数量一致，可以直接沿用，不强制人工重标。
- 如果源分段缺失，或源分段数量与当前 object 模板不一致，页面会提示“源分段不匹配，需人工确认”，保存前必须人工设置/确认断点。
- 标注员只需要标断点：N 段 subtask 需要 N-1 个断点，系统会自动推导每段 start/end；断点数量上限就是当前任务模板需要的 N-1。
- `B/C/D` 质量标记显示在三视角视频正下方，C/D 用红色强调，避免漏看。

播放器控制：

- 全局进度条：同步拖动 hand / view1 / view2
- Subtask timeline：全局进度条下方同时显示两层信息。灰色虚线/灰块是源 parquet 的原始参考分段，只用于查看；红色竖线和彩色分段块是当前可保存标注；黑色竖线为当前播放位置。
- `S`：在当前播放帧添加或取消断点；如果当前帧附近已有断点，则取消该断点，否则添加新断点
- `S 添加/取消当前帧断点` 按钮：和快捷键逻辑一致
- 如果断点数量已达上限，再按 `S` 会在 timeline 下方显示红色提示：请先 Reset，或移动到已有断点附近按 `S` 删除一帧。
- `Reset 清空当前断点` 按钮：清空当前红色可保存断点；灰色原始参考层仍然显示，但不会写入 `subtask_breakpoints` / `subtask_segments`
- `,` / `.`：逐帧后退 / 前进
- `<` / `>`：一次移动 10 帧
- `[` / `]`：降速 / 升速
- 支持 0.1×、0.25× 慢速播放

分段保存字段：

- `subtask_template`
- `subtask_expected_count`
- `subtask_expected_breakpoint_count`
- `subtask_breakpoint_count`
- `subtask_complete_count`
- `subtask_complete`
- `subtask_breakpoints[]`，包含每个断点 `frame/time/source`
- `subtask_segments[]`，包含每段 `start_time/end_time/start_frame/end_frame`

### 当前 package 的 subtask 说明

主 pipeline 的 LeRobot parquet 里有逐帧 `subtask` 整数列。`build_annotation_package.py`
会读取该列，把连续 label 转换为 `source_subtask.segments` 和 `initial_subtask_segments`。

UI 不显示原始 task/prompt，但会显示源分段状态，例如：

- `原始关键帧 4 个；源分段 5 段（ok）`
- `源 parquet 分段：5 段（ok）`
- `源分段匹配，可直接保存`
- `源分段不匹配，需人工确认`

如果显示 `原始关键帧 0 个；源分段 0 段（all_zero_or_missing）`，说明源 parquet/raw 中没有可复用的分段点；这种样本需要人工标注。

v12 交互语义：

- 进入一个样本时，如果已有上次保存结果，会加载为当前红色断点；如果没有保存结果但源分段可用，会作为当前候选断点加载，方便源分段正确时快速确认。
- 页面始终会把源 parquet 分段另画成灰色参考层。灰色层只是可视化提示，不代表当前标注。
- 点击 `Reset 清空当前断点` 后，只清空当前红色断点/分段；灰色源参考仍然显示，但不会保存。要重新标注时，移动到目标帧按 `S` 或按钮添加红色断点。
- 正常视频保存前必须选择 object/task；没有选择任务时不能直接保存并进入下一条。`bad_video` 仍可作为坏视频标签保存。

保存记录中会额外写入：

- `subtask_source_status`
- `subtask_source_segment_count`
- `subtask_source_matches_expected`
- `subtask_needs_manual_review`
- `subtask_manual_edited`

## 后续添加新数据

同一个 package 可以增量添加：

```bash
python3 build_annotation_package.py \
  --dataset /path/to/lerobot_clean_final \
  --package-dir /path/to/annotation_package \
  --timestamp-file /path/to/new_timestamps.txt \
  --append --copy-mode hardlink --shuffle
```

如果要给新一批标注员，建议单独新建 package 目录，避免 annotations 混在一起。
