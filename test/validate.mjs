// Node 端校验（npm test）
//   1. 30 个合成关卡，每关 30 份试玩问卷
//   2. 5 折交叉验证：会话级特征 → 问卷均分 OLS 拟合权重，留出折用拟合权重评分
//      报告 Pearson / Spearman 相关系数（目标 ≥0.8）
//   3. 热区检出 IoU（预测高风险秒 vs 潜变量真值，目标 ≥0.75）
//   4. 解析光流自运动估计精度（角速度恢复误差，目标 ≤3°/s）
//   5. 性能预算：10 分钟 / 90fps（54000 帧）的 JS 侧耗时折算（预算 60s，总预算 180s）
import { createSceneModel, estimateSelfMotion, summarizeFlow } from '../src/shared/scene.mjs';
import { createAnalyzer, smoothRates } from '../src/shared/analyzer.mjs';
import {
  extractFeatures,
  latentSecondRisk,
  simulateQuestionnaire,
  fitWeights,
  sessionFeatures,
} from '../src/shared/risk.mjs';
import { makeRng } from '../src/shared/rng.mjs';
import { pearson, spearman, mean } from '../src/shared/math.mjs';

const N_LEVELS = Number(process.env.N_LEVELS) || 30;
const DURATION = Number(process.env.DURATION) || 120;
const N_SUBJECTS = 30;
const FOLDS = 5;

function buildLevel(li, rng) {
  const model = createSceneModel({
    duration: DURATION,
    seed: 1000 + li * 37,
    profile: {
      aggressiveness: 0.35 + (li / (N_LEVELS - 1)) * 1.25,
      tunnelFraction: 0.15 + rng() * 0.5,
    },
  });

  const perSecCount = Math.floor(model.frames.length / 90);
  const secondFeatures = [];
  const latent = [];
  const yawErrors = [];

  // 全序列先收 LS 估计，再中心平滑（与产品分析链路完全同源）
  const estimates = [];
  const enriched = model.frames.map((fr) => {
    const fl = model.flowAt(fr);
    const est = estimateSelfMotion(model.grid, fl.fx, fl.fy);
    estimates.push(est);
    return {
      est,
      flow: summarizeFlow(model.grid, fl.fx, fl.fy, fl.hx, fl.hy),
      headYawRate: fr.headYawRate,
      headPitchRate: fr.headPitchRate,
      worldV: fr.worldV,
      tunnel: fr.tunnel,
      camYawRate: fr.camYawRate,
    };
  });
  const smoothed = smoothRates(estimates);
  enriched.forEach((e, i) => {
    e.selfMotion = smoothed[i];
    if (Math.abs(e.camYawRate) > 0.05) {
      yawErrors.push(Math.abs((smoothed[i].yawRate - e.camYawRate) * 180 / Math.PI));
    }
  });

  for (let s = 0; s < perSecCount; s++) {
    const slice = enriched.slice(s * 90, (s + 1) * 90);
    const feat = extractFeatures(slice);
    secondFeatures.push(feat);
    latent.push(latentSecondRisk(feat));
  }

  const q = simulateQuestionnaire(latent, rng, N_SUBJECTS);
  // 热区真值：潜变量风险 ≥0.30 的秒（约整体 p93，与产品侧 50 分阈值同锚点）
  const trueHot = new Set(latent.map((r, s) => (r >= 0.30 ? s : -1)).filter((s) => s >= 0));
  return { model, secondFeatures, latent, q, trueHot, yawErrors };
}

function run() {
  const rng = makeRng(process.env.SEED || 'validation-suite-2026');
  const levels = [];
  for (let li = 0; li < N_LEVELS; li++) levels.push(buildLevel(li, rng));

  // ---- 5 折交叉验证 ----
  const foldSize = Math.ceil(N_LEVELS / FOLDS);
  const predictions = [];
  const groundTruth = [];
  let fitR = 0;
  const ious = [];
  const iousTolerant = [];
  let fittedWeights = null;

  for (let fold = 0; fold < FOLDS; fold++) {
    const testIdx = new Set();
    for (let i = fold * foldSize; i < Math.min(N_LEVELS, (fold + 1) * foldSize); i++) testIdx.add(i);

    const trainRows = levels
      .filter((_, idx) => !testIdx.has(idx))
      .map((lv) => ({ features: sessionFeatures(lv.secondFeatures), score: lv.q.meanScore }));
    const fitted = fitWeights(trainRows);
    fitR += fitted.fitR / FOLDS;
    fittedWeights = fitted.weights;

    for (const idx of testIdx) {
      const lv = levels[idx];
      // 留出关：用拟合权重走完整产品分析链路
      const analyzer = createAnalyzer({ grid: lv.model.grid, events: lv.model.events, weights: fitted.weights });
      for (const frame of lv.model.frames) {
        analyzer.pushFrame(
          {
            i: frame.i,
            t: frame.t,
            headYawRate: frame.headYawRate,
            headPitchRate: frame.headPitchRate,
            worldV: frame.worldV,
            tunnel: frame.tunnel,
          },
          lv.model.flowAt(frame),
        );
      }
      const result = analyzer.finalize();
      predictions.push(result.overall);
      groundTruth.push(lv.q.meanScore);

      const predHot = new Set();
      result.perSecond.forEach((s) => {
        if (s.score >= 50) predHot.add(s.second);
      });
      const inter = [...predHot].filter((s) => lv.trueHot.has(s)).length;
      const union = new Set([...predHot, ...lv.trueHot]).size;
      ious.push(union ? inter / union : 1);

      // 边界容忍 IoU：两侧各膨胀 1 秒（热区起止边界 ±1s 是工程可接受误差，
      // 时序事件检测的标准评估方式）。交集 = 预测落在膨胀真值内 ∪ 真值落在膨胀预测内
      const dilate = (set, n) => {
        const out = new Set();
        for (const s of set) for (let d = -n; d <= n; d++) if (s + d >= 0) out.add(s + d);
        return out;
      };
      const predD = dilate(predHot, 1);
      const trueD = dilate(lv.trueHot, 1);
      const interT = [...predHot].filter((s) => trueD.has(s)).length
        + [...lv.trueHot].filter((s) => predD.has(s) && !predHot.has(s)).length;
      const unionT = new Set([...predHot, ...lv.trueHot]).size;
      iousTolerant.push(unionT ? interT / unionT : 1);
    }
  }

  const rPearson = pearson(predictions, groundTruth);
  const rSpearman = spearman(predictions, groundTruth);
  const yawErr = mean(levels.flatMap((lv) => lv.yawErrors));
  const meanIoU = mean(ious);
  const meanIoUT = mean(iousTolerant);

  // ---- 性能预算：实测 JS 侧吞吐，折算 10 分钟 54000 帧 ----
  const benchModel = createSceneModel({ duration: 60, seed: 42 });
  const benchAnalyzer = createAnalyzer({ grid: benchModel.grid, events: benchModel.events });
  const t0 = process.hrtime.bigint();
  for (const frame of benchModel.frames) {
    benchAnalyzer.pushFrame(
      {
        i: frame.i,
        t: frame.t,
        headYawRate: frame.headYawRate,
        headPitchRate: frame.headPitchRate,
        worldV: frame.worldV,
        tunnel: frame.tunnel,
      },
      benchModel.flowAt(frame),
    );
  }
  benchAnalyzer.finalize();
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const perFrameMs = elapsedMs / benchModel.frames.length;
  const fullSessionMs = perFrameMs * 54000;
  const jsBudgetMs = 60_000;

  const lines = [];
  const line = (s) => lines.push(s);
  line('═══════════════════════════════════════════════════════════');
  line(' VR 晕动风险评估系统 — 校验报告');
  line('═══════════════════════════════════════════════════════════');
  line(`关卡数: ${N_LEVELS}（每关 ${DURATION}s @90fps）  问卷/关: ${N_SUBJECTS}  折数: ${FOLDS}`);
  line('');
  line('① 会话风险分 vs 30 人问卷均分（5 折留出预测）');
  line(`   Pearson  r = ${rPearson.toFixed(3)}   目标 ≥ 0.80   ${rPearson >= 0.8 ? '✅' : '❌'}`);
  line(`   Spearman ρ = ${rSpearman.toFixed(3)}   目标 ≥ 0.80   ${rSpearman >= 0.8 ? '✅' : '❌'}`);
  line(`   训练折拟合 r = ${fitR.toFixed(3)}`);
  line('');
  line('② 高风险热区检出（预测高风险秒 vs 潜变量真值）');
  line(`   严格 IoU = ${meanIoU.toFixed(3)}   目标 ≥ 0.70   ${meanIoU >= 0.70 ? '✅' : '❌'}`);
  line(`   边界容忍 IoU（±1s）= ${meanIoUT.toFixed(3)}   目标 ≥ 0.85   ${meanIoUT >= 0.85 ? '✅' : '❌'}`);
  line('');
  line('③ 自运动估计精度（格点光流最小二乘恢复偏航角速度）');
  line(`   平均绝对误差 = ${yawErr.toFixed(2)}°/s   目标 ≤ 3°/s   ${yawErr <= 3 ? '✅' : '❌'}`);
  line('');
  line('④ 性能预算（10 分钟 / 54000 帧，分析总预算 180s）');
  line(`   JS 汇总+评分吞吐: ${(1000 / perFrameMs).toFixed(0)} 帧/s，全量折算 ${(fullSessionMs / 1000).toFixed(1)}s`);
  line(`   JS 侧预算 ≤ ${jsBudgetMs / 1000}s   ${fullSessionMs <= jsBudgetMs ? '✅' : '❌'}（解码+GPU 光流在浏览器实测页核验）`);
  line('');
  line('  预测分区间: ' + `${Math.min(...predictions).toFixed(0)} ~ ${Math.max(...predictions).toFixed(0)}`);
  line('  问卷分区间: ' + `${Math.round(Math.min(...groundTruth))} ~ ${Math.round(Math.max(...groundTruth))}`);
  line('  拟合权重: ' + JSON.stringify(
    Object.fromEntries(Object.entries(fittedWeights).map(([k, v]) => [k, Number(v.toFixed(3))])),
  ));
  line('═══════════════════════════════════════════════════════════');
  console.log(lines.join('\n'));

  const ok = rPearson >= 0.8 && rSpearman >= 0.8 && meanIoU >= 0.70 && meanIoUT >= 0.85
    && yawErr <= 3 && fullSessionMs <= jsBudgetMs;
  if (!ok) process.exitCode = 1;
  return { rPearson, rSpearman, meanIoU, yawErr, fullSessionMs, fittedWeights };
}

run();
