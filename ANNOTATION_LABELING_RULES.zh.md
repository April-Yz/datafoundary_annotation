# 任务名称与 Subtask 标注规则

本文档给标注员使用。目标是只看三视角视频，重新确认任务名称、必要时核对 subtask 分段，并记录坏视频/主视角偏移/跳变等质量问题。

## 1. 标注原则

- 不根据原始 prompt 或旧 task 猜测；只根据视频内容判断。
- 正常情况下只需要选择机箱类型 + 物体，然后按 `Enter` 保存。
- 机箱类型没有默认值，每条都必须选：大机箱或小机箱。
- 动作前缀默认是 `none`，不要随便加动作前缀。
- 如果看不清或视频坏，勾选 `B bad video`。
- 如果不确定，请在备注中写清楚，不要乱猜。

## 2. 页面区域说明

页面从上到下大致是：

1. 上一个 / 下一个 / timestamp
2. 开始、中间、结束预览图
3. 三视角视频
4. B/C/D 质量标记
5. 播放控制、进度条、subtask timeline
6. 机箱类型 / object / action 选择
7. subtask 分段提示
8. 备注与保存按钮

## 3. 机箱类型 Chassis 怎么选

每条都必须选择一个机箱类型，没有默认选项：

- `6`：大机箱
- `7`：小机箱

即使视频是 bad video，也需要先选择大机箱或小机箱，再保存。

保存结果里会记录：

- `chassis_type`：`large_case` 或 `small_case`
- `chassis_label`：`大机箱` 或 `小机箱`

## 4. 物体 Object 怎么选

快捷键：

- `1`：cpu
- `2`：disk
- `3`：gpu
- `4`：ram
- `5`：ram2
- `8`：自定义 object

正常视频必须选择一个 object，才能保存并进入下一条。

### ram 和 ram2

`ram` 和 `ram2` 要区分。若视频里明确是第二根 RAM 或标注规范要求 ram2，则选 `ram2`。

### 自定义 object

只有当物体不属于 cpu/disk/gpu/ram/ram2 时才选 `8 自定义`，并填写英文小写名称，例如：

```text
motherboard
cable
screw
```

不要填写 `unknown`。如果真的看不清，应该勾选 `bad video`。

## 5. Action 前缀怎么选

默认保持 `none`。

快捷键：

- `0`：none
- `Q`：pick_up
- `W`：insert
- `E`：pick_up_and_insert
- `9`：other_action

绝大多数完整任务应该是：

```text
none + object
```

最终输出就是：

```text
cpu / disk / gpu / ram / ram2
```

只有当视频明显只是一个子动作，而不是完整任务时，才选择 action 前缀，例如：

```text
pick_up_cpu
insert_gpu
pick_up_and_insert_ram
```

如果不确定是否需要 action 前缀，优先保持 `none`，并在备注中说明疑点。

## 6. B/C/D 质量标记

B/C/D 位于三视角视频正下方。

- `B bad video`：视频坏、看不清、严重缺视角、无法判断任务
- `C 主视角严重偏移`：主视角偏得很厉害，但视频可能仍能判断任务
- `D 是否跳变`：视频存在明显时间跳变、画面突变、动作不连续

快捷键：

- `B`：切换 bad video
- `C`：切换主视角严重偏移
- `D`：切换跳变

如果勾选 `B bad video`，可以不选 object 直接保存为坏视频。

如果只是 C 或 D，但仍能判断任务，仍然要正常选择 object/action。

## 6. Subtask 分段怎么处理

### 6.1 什么时候需要关注 subtask

如果 action 是 `none`，表示这是完整任务。完整任务通常需要对应数量的 subtask 分段。

标准段数：

- cpu：6 段，需要 5 个断点
- disk：4 段，需要 3 个断点
- gpu：标准 4 段，需要 3 个断点；如果确实需要额外阶段，可以加第 4 个断点，生成 `S5 / gpu_subtask_5`
- ram：5 段，需要 4 个断点
- ram2：同 ram，5 段，需要 4 个断点

页面会提示当前任务需要几个断点。

### 6.2 Timeline 颜色含义

- 灰色虚线/灰色块：原始 source 分段，只是参考，不会保存
- 红色竖线：当前会保存的断点
- 彩色块：由当前红色断点推导出的当前分段
- 黑色竖线：当前播放位置

不要把灰色参考误认为最终标注。最终保存的是红色断点。

### 6.3 添加/删除断点

把视频停在目标帧，然后：

- 按 `S`：添加当前帧为断点
- 如果当前帧附近已有断点，按 `S` 会删除附近那个断点
- 也可以点击 `S 添加/取消当前帧断点` 按钮

如果断点已经达到上限，再按 `S` 会出现红色提示：

```text
断点已满：请先 Reset，或把播放位置移到已有断点附近按 S 删除一帧。
```

### 6.4 Reset

`Reset 清空当前断点` 只清空红色当前断点。

灰色 source 参考仍然会显示，但不会保存。

如果你觉得当前断点乱了，可以：

1. 点 `Reset 清空当前断点`
2. 从头播放或逐帧检查
3. 用 `S` 重新添加断点

## 7. 播放与查看快捷键

- `Space`：播放 / 暂停
- `,`：后退 1 帧
- `.`：前进 1 帧
- `<`：后退 10 帧
- `>`：前进 10 帧
- `[`：降速
- `]`：升速
- 全局进度条：同步拖动三个视频
- 跳到帧 / 跳到秒：用于精确定位

建议先看开始/中间/结束预览，再用视频确认。

## 8. 保存规则

点击 `Enter 保存并下一个` 或按 `Enter` 保存。

正常视频必须满足：

- 已选择机箱类型：大机箱或小机箱
- 已选择 object
- 如果 object 是自定义，必须填写自定义名称
- 如果 action 是 `none` 且有标准 subtask 模板，需要断点数量满足要求

坏视频：

- 勾选 `B bad video` 后可以不选 object，但仍然必须选择机箱类型
- 建议在备注里写原因，例如：`view1 blocked`、`all views black`、`cannot identify object`

## 9. 备注怎么写

备注可以为空。

建议写备注的情况：

- 视频里像 gpu，但实际更像 disk
- 物体不确定
- 任务中途失败但仍能判断类别
- 视角缺失或视频跳变
- 使用了自定义 object

备注尽量简短，例如：

```text
looks like disk, old label may be gpu
main view shifted but hand view ok
task failed near the end
```

## 10. 不要做的事情

- 不要直接编辑 `annotations.jsonl`
- 不要直接编辑 `annotations_latest.json`
- 不要删除 videos / previews
- 不要用 `file://` 打开网页标注
- 不要在没看视频的情况下只按旧标签保存
- 不要把看不清的物体标成 unknown；看不清用 `bad video`

## 11. 最终交付

标注完成后，把下面文件发回：

必须：

- `annotations.jsonl`
- `annotations_latest.json`

建议一起发：

- `package_manifest.json`
- `items.jsonl`

不用发视频文件，除非另行要求。

推荐打包：

```bash
PACKAGE_DIR=/path/to/task_annotation_package
ANNOTATOR=your_name

cd "$PACKAGE_DIR"
tar -czf annotation_result_${ANNOTATOR}_$(date +%Y%m%d_%H%M).tar.gz \
  annotations.jsonl \
  annotations_latest.json \
  package_manifest.json \
  items.jsonl
```

交付前可以检查：

```bash
wc -l annotations.jsonl
python3 -m json.tool annotations_latest.json >/dev/null && echo "JSON OK"
```
