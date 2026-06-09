# 风扇智能调优(Fan Auto-Tune)设计

日期:2026-06-10
状态:已与用户逐段确认(流程 / 数学核心 / 被动学习与架构)
前置:`2026-06-04-fan-control-design.md`(风扇控制引擎与 PWM↔RPM 校准已落地)

## 1. 目标与定位

为 FanControl tab 增加一套**针对本机散热系统的闭环智能调优**:实测「风扇风量 → 满载 CPU
温度」的真实关系,为当前这颗 CPU、这个散热器、这套机箱风道合成最优温度→占空比曲线。

现有 `fan_calibrate` 只标定了风扇本身(占空比↔RPM);本设计在其上补齐**热学闭环**:

- 满载(持续最坏情况)时 CPU 封装温度恰好钉在**用户设定的目标最高温度**(不是 TjMax 温度墙);
- 低负载时风扇贴着用户的**安静底线**转速;
- 全程不超过用户的**噪音上限**(紧急高温除外),上限内压不住时**明确告知可达温度**;
- 日常使用中**被动学习**漂移(积灰 / 换季 / 环温),小步自动修正。

### 成功标准

- 向导典型总时长 ≤ 25 分钟(风扇校准 + 怠速基线 + 4×3 满载网格 + 验证);
- 满载验证收敛温度与目标偏差 ≤ ±1.5 °C;
- 低温区风扇稳定停在安静底线,无可感知的转速"呼吸"振荡(占空比峰峰 ≤ 12%);
- 不可行时(上限太低 / 散热器不够)给出诚实、可操作的警告与一键选项;
- 修改目标温度 / 底线 / 上限**秒级重算**曲线,无需重新测量。

## 2. 用户参数(`AutoTuneParams`)

| 参数 | 范围 | 默认 | 含义 |
|---|---|---|---|
| `targetTempC` | 60–88 °C | 85 | 满载时 CPU(Tctl/Tdie)应钉住的最高温度;上限 88 给 TjMax=89 的 9950X3D 留 1 °C 余量 |
| `quietFloorPct` | 0–60 % | 25 | 安静底线:低温时每个风扇跑自己最大转速的百分比(w_floor) |
| `noiseCeilPct` | 40–100 % | 100 | 噪音上限:正常运行风量分数封顶(w_ceil);温度 ≥ 目标+6 °C 的紧急区**无视上限** |
| `groups` | 每风扇 `cpu`/`case`/`excluded` | 按名预判 | 风扇分组(见 §3 阶段 0) |

约束:`noiseCeilPct ≥ quietFloorPct + 15`(UI 直接阻止,避免无解)。

**风量分数 w 的定义**(贯穿全文):组内每个风扇都跑到*自己*最大实测转速的 w×100%,占空比
由该风扇自己的校准数据反查。这把杂牌混装风扇归一成一个组级控制量。

## 3. 调优向导:阶段与流程

一个向导模态,随时可中止;中止 / 失败一律走同一个恢复函数:风扇恢复调优前配置、杀负载、
清理状态。后端状态机:

```
Idle → Precheck → FanCalib → Baseline → GridSweep → Fit → Synthesize → Validate → Done
                                                  ↘ (任何阶段) Aborted(reason)
```

### 阶段 0 · 参数页(前端)

- 上述四个参数的设置 UI(目标温度滑条、两个转速旋钮、分组确认)。
- 分组预判(按接口名,用户可逐个改组或排除):
  1. 先匹配水泵 `/pump|水泵/i` → **强制 excluded**(水泵必须恒速,绝不能挂温度曲线;UI 说明原因);
  2. 再匹配 `/cpu|aio|opt/i` → `cpu` 组;
  3. 其余 → `case` 组。GPU 自带风扇(`hw` 为 GPU)不出现在分组列表(归显卡驱动管)。
- CPU 组至少 1 个风扇,否则禁止开始;**case 组允许为空**(此时模型退化为 1 维,见 §5)。

### 阶段 Precheck(后端)

- sensord 在线,`cpuTemp` / `cpuPower` 有读数;
- 静默检查:30 秒内 `sysmon` 总占用平均 < 10% 且无单样本 > 25%,否则报「请先关闭后台负载」;
- 快照当前 `FAN_CONFIG` 供恢复;置 `CALIBRATING` 标志暂停常规引擎(复用现有机制)。

### 阶段 1 · FanCalib(约 30 s/风扇)

复用现有 `fan_calibrate` 扫描参与的风扇,产出每扇 `points: (duty, rpm)[]`、`minStartDuty`、
`maxRpm`。若 store 里有 **30 天内**的同一组风扇校准结果,参数页提供「跳过(用上次校准)」。
`disconnected` 的风扇自动从组里剔除并在结果页提示。

### 阶段 2 · Baseline(约 1.5 min)

两组 `w = max(0.40, w_floor)`(底线可被用户设到 0.60,不能低于它),等稳态(判据见下),
记录 `tIdle`(末 10 s 均值)、`pIdle`(驻留期均值)。
该点锚定模型的环境项 `T_off`。

**稳态判据**(全文通用):1 Hz 采样,滑动 25 样本窗内线性回归斜率 < 0.05 °C/s 且窗内
极差 < 0.8 °C;最短驻留 35 s,最长 120 s(到顶则取当前值并标记 `saturated=false`,
后续由保守偏置 + 验证阶段兜底 —— 对热惯性大的 AIO 尤其重要)。

### 阶段 3 · GridSweep(约 12–18 min,核心)

1. **启动负载**(`load_gen.rs`):每逻辑核 1 线程、`BELOW_NORMAL` 优先级、纯寄存器整数乘加
   循环(CPU-Z 式,不碰内存,不用 AVX);`AtomicBool` 停止,RAII Drop 守护(调优线程
   panic 也会停)。15 s 内验证:`sysmon` 总占用 ≥ 95% **且** `cpuPower ≥ 1.5 × pIdle`,
   否则 Abort(「负载未生效」)。
2. **网格**:`w_cpu ∈ {1.00, 0.75, 0.50, 0.35} × w_case ∈ {1.00, 0.60, 0.30}`,共 12 点;
   case 组为空时退化为 4 点 1 维。顺序从全速开始、按行降风量(每步都是小扰动):
   `(1,1)(1,.6)(1,.3)(.75,1)…(.35,.3)`。
3. 每点:下发两组占空比 → 等稳态 → 记录 `(wCpu, wCase, tSs, pAvg, 每扇均值 RPM, saturated)`。
4. **增量拟合跳点**:累计 ≥ 4 点后每点重拟合一次模型,**预测 ≥ T_abort − 2 °C 的后续点直接
   跳过不测**(标记 skipped,拟合用已测点足够)。

### 全程安全网(1 Hz,所有阶段)

- 测量阶段(Baseline / GridSweep)中止线固定 `T_abort = 88 °C`(低于 Zen5 全系 TjMax,
  9950X3D 为 89)。**故意与用户目标解耦**:激进目标 + 弱散热器时,测量仍能完成并产出
  「散热器不足」的诚实警告,而不是莫名其妙地中途中止。验证阶段中止线收紧为
  `min(effectiveTarget + 4, 88)`。触发即:全部风扇 100% → 杀负载 → 恢复原配置 →
  `Aborted("温度超限")`。(silicon 在 TjMax 还有降频自保护,这层在它之下。)
- sensord 断线 / 温度读数消失 > 5 s → Abort;
- 挂起/恢复检测(单调钟与墙钟差跳变 > 10 s)→ Abort;
- 总时长硬上限 35 min → Abort;
- 用户点「中止」→ Abort(同一路径)。

## 4. 热阻模型与拟合(阶段 Fit)

```
T_ss(P, w_cpu, w_case) = T_off + P · [ R∞ + k_c·φ(w_cpu) + k_x·φ(w_case) ]
φ(w) = (w + 0.1)^(−α)
```

- 物理含义:`T_off`≈环境温度项;`R∞`=风量拉满后的剩余热阻(散热器物理极限);
  `k_c`/`k_x`=CPU 组 / 机箱组的加风降温能力;φ 刻画边际递减。
- α 固定枚举 `{0.6, 0.8, 1.0}`:对每个 α,模型对 `(T_off, R∞, k_c, k_x)` 是**线性**的 →
  普通最小二乘(数据 = 12 网格点 + 1 基线点,4 未知数,超定)。负系数钳到 0 后对其余
  变量重解一次(4 变量的投影式 NNLS,迭代 ≤ 3 次)。取 RSS 最小的 α。
  约束:`R∞ ≥ 0.01`,`k_c, k_x ≥ 0`,`T_off ∈ [10, 50]`。
- **保守偏置**:`T_off += max(0, P90(残差))` —— 模型永远偏热,曲线宁吵勿超温。
- case 组为空:删去 `k_x` 项,3 参数同法。
- 产出 `model = { alpha, tOff, rInf, kC, kX, rmse, conservativeShift }`。

**噪音目标函数**(合成用):`N(w) = Σ_f (w_g(f) · maxRpm_f / 1000)²` —— 平方惩罚自动把
风量摊到还安静的那一组,而不是单组拉爆。

## 5. 曲线合成(阶段 Synthesize,纯函数,可秒级重算)

输入:`model` + 每扇校准 + `AutoTuneParams`。输出:每扇 `FanCurvePoint[]`(温度→占空比,
≤ 24 点)+ `minDuty` + 平滑参数。**现有引擎 / 曲线编辑器 / 配置档案零改动直接执行。**

1. `P_design = max(网格各点 pAvg)`(全核满载即持续最坏情况)。
2. **可行性裁决**(`w_ceil = noiseCeilPct/100`):
   - `T_model(P_design, w_ceil, w_ceil) > target`?
     - 若 `T_model(P_design, 1, 1) > target` → 警告 **cooler-insufficient**:「散热器能力不足,
       满载最低 Z °C」;`effectiveTarget = Z + 1`,曲线锚定 100%。
     - 否则警告 **ceiling-insufficient**:「上限 X% 内满载最低只能压到 Y °C」+ 一键选项
       (a) 放宽上限重算 (b) 接受 `effectiveTarget = Y + 0.5` 重算。
   - 否则 `effectiveTarget = target`。
3. **满载锚点**:`w_req = argmin N(w)` s.t. `T_model(P_design, w) = effectiveTarget`,
   `w ∈ [floor, ceil]²`。解法:w_cpu 以 0.01 步长扫 [floor, ceil],由等式解出 w_case
   (φ 可解析求逆),越界跳过,取 N 最小。case 组为空时直接一维解。
4. **比例带**:`B = 8 °C`,`T_low = effectiveTarget − B`。
   `P_knee` 由 `T_model(P, floor, floor) = T_low` 解出(模型对 P 线性,解析解)。
   - 调度 j = 0..5:`P_j = P_knee + (P_design − P_knee)·(j/5)`,
     `T_j = T_low + B·(j/5)^1.5`,并钳到可行域 `T_j ≥ T_model(P_j, ceil, ceil) + 0.3`;
     钳制后再强制严格递增(`T_j = max(T_j, T_{j−1} + 0.2)`)保证曲线单值;
     每个 `T_j` 解一次第 3 步的最安静组合 → 平衡点 `(T_j, w_cpu_j, w_case_j)`。
   - 温度调度严格递增 ⇒ 曲线单值;斜率有限 ⇒ **目标温度处无垂直跳变,不振荡**。
   - 若 `P_knee ≥ P_design`(底线已压住一切)→ 曲线 = 底线平线 + 安全爬升,结果页说明。
5. **完整组级 w 曲线**(每组 9 点):
   `(20, floor)`、`(T_low, floor)`、j=1..5 的调度点、`(effectiveTarget+3, ceil)`、
   `(effectiveTarget+6, 1.0)`(紧急区无视上限,文档与结果页明示)。强制非降。
6. **映射到每扇占空比**:`duty_f(w)` = 在该扇校准样本上反查达到 `w × maxRpm_f` 的占空比
   (Rust 侧移植现有 `dutyForRpmFraction` 逻辑),钳到 `[max(minStartDuty_f, 20), 100]`。
   每扇 `minDuty = duty_f(floor)`;`spinUpPct = 70`,`spinDownPct = 30`(下行平滑防呼吸)。

## 6. 满载验证(阶段 Validate,闭环兜底)

负载继续跑,调优线程自己按合成曲线驱动(2 s 节拍:读 Tctl → 插值组级 w → 每扇占空比,
带 ±8%/tick 斜率限制;此时 `CALIBRATING` 仍置位,常规引擎不抢):

- 等稳态(最短 60 s)→ `tV = 末 20 s 均值`,预算 3–4 min/轮;
- `tV − effectiveTarget > 1.5` → `tOff += (tV − effectiveTarget)` 重合成重验
  (牛顿式一步校正,**最多 2 轮**);
- `effectiveTarget − tV > 4` → 同法回调一次(偏冷安全,只修一次,不折腾);
- 振荡检测:末 60 s CPU 组占空比峰峰 > 12% → `B += 2`、`spinDownPct −= 10`,
  重合成重验**一次**;
- 验证总预算 ≤ 12 min(含在 35 min 硬上限内);剩余预算不足再跑一轮时,接受当前曲线
  并在结果页标注「验证未完全收敛,偏差 X °C」(被动学习会继续收口)。

通过 → `Done`,产出 `AutoTuneResult`;前端立即 `fan_set_config` 推送曲线(Done 与推送之间
常规引擎可能按旧配置跑 1 个 tick,转速本就相近,无害),并自动另存配置档案
「智能调优 YYYY-MM-DD HH:mm」。

## 7. 被动学习(日常自动微调)

- **采样**(后端,常规引擎节拍顺带):仅当「调优曲线正在生效」且 CPU 占用 ≥ 90% 持续
  ≥ 120 s 且温度 / 转速均稳态时,记录 `(pAvg, wCpu, wCase, tObs)`;环形缓冲 50 条,
  两条间隔 ≥ 10 min。
- **修正**:每天或攒满 5 条新样本 → 对比模型预测的中位残差 `e`;
  - 偏热(`e > 1.5`):`tOff += clamp(e, ≤ +0.5/天)`,自动生效;
  - 偏冷(`e < −2.5` 才动):同法回调 —— **安全不对称,永远偏向偏热修正**;
  - 距标定基线累计漂移钳在 ±6 °C;
  - 修正后秒级重算曲线 → 事件通知前端 → 自动应用 + 通知日志:「被动学习:满载温度比
    预期高 2.1 °C(可能积灰/环温变化),已自动加强曲线」。
- **暂停条件**:用户手改了任何参与风扇的曲线(前端对比当前配置与最新合成曲线,发散即
  下发 passive-pause,该结果标记 custom);设置里有总开关(默认开)。

## 8. 架构与组件

| 组件 | 类型 | 职责 |
|---|---|---|
| `src-tauri/src/fan_autotune/mod.rs` | 新,Rust ~300 行 | 状态机 + 安全网 + 进度事件;`spawn_blocking` 线程;复用 `CALIBRATING`、`send_set`、`fan_calibrate` |
| `src-tauri/src/fan_autotune/model.rs` | 新,Rust ~350 行 | 拟合 / 等温求解 / 曲线合成 / 占空比反查 —— **全部无副作用纯函数** |
| `src-tauri/src/load_gen.rs` | 新,Rust ~80 行 | 全核负载发生器(RAII 守护) |
| Tauri 命令 | 新 | `fan_autotune_start(params)` / `fan_autotune_abort()` / `fan_autotune_resynth(params)`(秒级重算)/ `fan_passive_configure(model, calibs, groupOf, enabled)`(被动采样需要模型与校准在后端;应用曲线后由前端下发)/ 被动状态查询 |
| 事件 | 新 | `fan-autotune-progress`(阶段/工况点/实时 T·P·RPM/预计剩余)、`fan-autotune-passive`(修正通知+新曲线) |
| `src/store/fanAutotune.ts` | 新,zustand persist | `AutoTuneResult`(模型+网格+校准)、参数、被动学习累计修正与通知日志(≤ 20 条)—— 沿用 fanProfiles 持久化模式 |
| `src/components/fans/AutoTuneWizard.tsx` | 新 ~400 行 | 三步向导:参数页 → 运行页(实时走线、网格完成度、中止)→ 结果页(散热能力摘要、两组曲线预览、tV、警告与一键选项、应用/放弃) |
| `src/tabs/FanControl.tsx` | 改 ~60 行 | 「智能调优」主按钮 + 状态条(上次调优、被动学习累计修正、目标温度快改→resynth) |
| `src/lib/ipc.ts` | 改 | 新类型:`AutoTuneParams` / `AutoTuneProgress` / `AutoTuneResult` 等 |

- **测试注入缝**:状态机通过 `trait TuneIo { fn temp() / power() / load_pct() / set_duty() / now() }`
  访问外界;真实现读 SNAP / 走 sidecar,仿真实现是虚拟机箱(见 §10)。
- 文件守住 < 800 行;`mod.rs` 超限就拆 `sweep.rs`。
- i18n:所有新 UI 文案走 `tf(zh, en)` / 词典(遵循项目 i18n 约定)。

## 9. 错误处理

- 所有失败路径(任意阶段)收敛到同一个恢复函数:恢复 `FAN_CONFIG` 快照 → 清
  `CALIBRATING` → 杀负载 → `Aborted(reason)` 事件(双语 reason)。
- 调优中风扇 RPM 掉 0(占空比 > 起转值):该扇记 warning 继续;若它是 CPU 组唯一风扇 → Abort。
- `fan_autotune_start` 并发互斥(已有调优 / 校准在跑则拒绝,复用 `CALIBRATING` swap 语义)。
- 前端 apply 失败沿用 fanProfiles 的 `lastError` 呈现路径。

## 10. 测试

- **Rust 单测(model.rs)**:已知参数生成带噪合成数据 → 拟合还原(容差内);α 枚举选优;
  保守偏置;等温求解器边界(floor=ceil、case 组空、不可行钳制);合成曲线单调 / 点数 /
  紧急区;两类可行性警告分支;占空比反查(非线性 RPM 样本)。
- **闭环仿真测(关键)**:虚拟机箱 = 一阶热惯性 `dT/dt = (T_ss(P,w) − T)/τ`(τ 取 30 s 与
  150 s 两档,模拟风冷 / AIO)+ 完整状态机跑通 → 断言:收敛 |tV − target| ≤ 1.5 °C、
  无持续振荡、网格跳点正确、温度超限触发 Abort 且风扇先到 100%。
  再用**故意失配**的虚拟机箱(模型预测偏 5 °C)断言验证阶段把它拉回容差内。
- **TS 单测**:store 逻辑(结果持久化、被动日志上限、手改检测→passive-pause)。
- **硬件实测**:用户在 9950X3D 上跑完整向导(与 SMU 功能同样的实机验证流程)。

## 11. 明确不做(本期范围外)

- GPU 自身风扇调优(归显卡驱动);
- 多温度源混合曲线(如机箱扇跟随 GPU 温度 —— 列为后续方向);
- 逐风扇 N 维归因扫描(组合爆炸,收益被测量噪声淹没);
- 外接环温传感器;
- 把常规引擎改成运行时 PID(路线 C 已否决,其思想保留在验证阶段)。
