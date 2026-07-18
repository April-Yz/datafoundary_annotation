# 565h 后机箱与异常标注规则

本分支只用于 565h 版本之后新增的数据。每条 episode 只标注机箱类型和三项异常，不标任务名称、任务片段、Subtask 或断点。

## 1. 必选：机箱类型

- `6`：大机箱
- `7`：小机箱

页面没有默认选项。每条都必须选择机箱，即使视频损坏也不能跳过。

## 2. 三项异常

- `B bad_demo`：视频损坏、无法正常播放，或内容严重异常到无法可靠使用。
- `C camera_shift`：主视角严重偏移，看不到料盘或关键操作区域。
- `D 是否跳变`：视频或动作出现明显时间跳变、突变或不连续。

三项异常默认都不选。正常 episode 只需按 `6` 或 `7` 选择机箱，再按 `Enter` 保存。

## 3. 播放快捷键

- `Space`：播放 / 暂停
- `,` / `.`：后退 / 前进一帧
- `<` / `>`：后退 / 前进十帧
- `[` / `]`：降低 / 提高播放速度
- `←` / `→`：上一条 / 下一条
- `Enter`：保存并进入下一条

全局进度条会同步拖动三个视角。

## 4. 保存内容

每条结果严格只有：

```text
episode_index, demo_timestamp, camera_shift, bad_demo, 是否跳变, chasis_label
```

其中 `chasis_label` 只会是 `large` 或 `small`。工具不会保存旧 task、prompt、Subtask 或断点。

## 5. 注意事项

- 不要重新解压原始数据包覆盖已经标注过的目录。
- 不要手工编辑 `annotations.jsonl` 或 `annotations_latest.json`。
- 可以随时关闭服务；已成功保存的记录会保留。
- 更新 Git 代码不会覆盖标注结果，因为结果保存在数据 package 中。

## 6. 最终交付

必须交回：

- `annotations.jsonl`
- `annotations_latest.json`

建议同时交回：

- `items.jsonl`
- `package_manifest.json`

不需要交回视频。
