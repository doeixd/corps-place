import { Effect, Console } from 'effect';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

type Metrics = {
  deltaMaePts: number;
  recapMaePts: number;
  categoryMaePts: number;
  totalMaePts: number;
  coverage: number;
  width: number;
  widthFloorPct: number;
};

type RunSummary = {
  id: string;
  stage: string;
  args: string[];
  logPath: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  completed: boolean;
  unstable: boolean;
  aborted: boolean;
  lastEpoch: number | null;
  lastTrainLoss: number | null;
  lastValLoss: number | null;
  lastDeltaMaePts: number | null;
  lastCoverage: number | null;
  lastMonScore: number | null;
  testMetrics: Metrics | null;
  notes: string[];
};

type RunDef = {
  id: string;
  stage: string;
  args: string[];
  fallbackFor?: string;
};

type CliArgs = {
  epochs: number;
  samplesPerEpoch: number;
  batch: number;
  pollSeconds: number;
  prefix: string;
  trainingScript: string;
  outDir: string;
  dryRun: boolean;
  skipControl: boolean;
  limitRuns?: number;
  maxRows?: number;
  valMode: string;
  valDateCutoff?: string;
  divisionFilter: string;
  curriculumPhaseAEnd?: number;
  curriculumPhaseBEnd?: number;
  curriculumPhaseCRamp?: number;
  autoCurriculum?: string;
  autoCurriculumPatience?: number;
  autoCurriculumMinCoverage?: number;
  autoCurriculumMinDeltaGain?: number;
  autoCurriculumPhaseAMin?: number;
  autoCurriculumPhaseBMin?: number;
  widthTargetPts?: number;
  widthPenaltyWeight?: number;
  coverageTarget?: number;
  overCoverageWeight?: number;
  coverageUpperTarget?: number;
  historyHideRate?: number;
  opencodeAnalyze: boolean;
  opencodePromptFile: string;
  opencodeModel?: string;
  opencodeAgent?: string;
  opencodeCmd?: string;
};

const getArg = (argv: string[], key: string, fallback?: string): string | undefined => {
  const idx = argv.indexOf(key);
  if (idx === -1 || idx + 1 >= argv.length) return fallback;
  return argv[idx + 1];
};

const hasFlag = (argv: string[], key: string): boolean => argv.includes(key);

const optionalNumberArg = (argv: string[], key: string): number | undefined => {
  const value = getArg(argv, key);
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseCli = (argv: string[]): CliArgs => ({
  epochs: Number(getArg(argv, '--epochs', '400')),
  samplesPerEpoch: Number(getArg(argv, '--samples-per-epoch', '4096')),
  batch: Number(getArg(argv, '--batch', '128')),
  pollSeconds: Number(getArg(argv, '--poll-seconds', '60')),
  prefix: String(getArg(argv, '--prefix', 'v9fix')),
  trainingScript: String(
    getArg(argv, '--training-script', 'src/training/trainModelV9Subcaption-fixed.ts')
  ),
  outDir: String(getArg(argv, '--out-dir', 'results/ablation')),
  dryRun: hasFlag(argv, '--dry-run'),
  skipControl: hasFlag(argv, '--skip-control'),
  limitRuns: optionalNumberArg(argv, '--limit-runs'),
  maxRows: optionalNumberArg(argv, '--maxRows'),
  valMode: String(getArg(argv, '--val-mode', 'show-random')),
  valDateCutoff: getArg(argv, '--val-date-cutoff'),
  divisionFilter: String(getArg(argv, '--division-filter', 'all')),
  curriculumPhaseAEnd: optionalNumberArg(argv, '--curriculum-phase-a-end'),
  curriculumPhaseBEnd: optionalNumberArg(argv, '--curriculum-phase-b-end'),
  curriculumPhaseCRamp: optionalNumberArg(argv, '--curriculum-phase-c-ramp'),
  autoCurriculum: getArg(argv, '--auto-curriculum'),
  autoCurriculumPatience: optionalNumberArg(argv, '--auto-curriculum-patience'),
  autoCurriculumMinCoverage: optionalNumberArg(argv, '--auto-curriculum-min-coverage'),
  autoCurriculumMinDeltaGain: optionalNumberArg(argv, '--auto-curriculum-min-delta-gain'),
  autoCurriculumPhaseAMin: optionalNumberArg(argv, '--auto-curriculum-phase-a-min'),
  autoCurriculumPhaseBMin: optionalNumberArg(argv, '--auto-curriculum-phase-b-min'),
  widthTargetPts: optionalNumberArg(argv, '--width-target-pts'),
  widthPenaltyWeight: optionalNumberArg(argv, '--width-penalty-weight'),
  coverageTarget: optionalNumberArg(argv, '--coverage-target'),
  overCoverageWeight: optionalNumberArg(argv, '--over-coverage-weight'),
  coverageUpperTarget: optionalNumberArg(argv, '--coverage-upper-target'),
  historyHideRate: optionalNumberArg(argv, '--history-hide-rate'),
  opencodeAnalyze: hasFlag(argv, '--opencode-analyze'),
  opencodePromptFile: String(
    getArg(argv, '--opencode-prompt-file', 'prompts/v9-ablation-analysis.md')
  ),
  opencodeModel: getArg(argv, '--opencode-model'),
  opencodeAgent: getArg(argv, '--opencode-agent'),
  opencodeCmd: getArg(argv, '--opencode-cmd'),
});

const nowStamp = () => {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const readFileSafe = (filePath: string): string => {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
};

const parseLastEpochMetrics = (logText: string) => {
  const re = /^Epoch\s+(\d+):([^\r\n]*)$/gm;
  const readTail = (tail: string, key: string) => {
    const match = new RegExp(`${key}\\s*=\\s*([^\\s]+)`).exec(tail);
    return match?.[1] ?? null;
  };
  const readNumber = (tail: string, key: string) => {
    const value = readTail(tail, key);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  let m: RegExpExecArray | null;
  let last: {
    epoch: number;
    loss: number | null;
    valLoss: number | null;
    phase: string | null;
    delta: number;
    cov: number;
    monScore: number;
    progress: string | null;
    epochSec: number | null;
    avgEpochSec: number | null;
    elapsed: string | null;
    eta: string | null;
  } | null = null;
  while ((m = re.exec(logText)) !== null) {
    const tail = m[2] ?? '';
    const delta = readNumber(tail, 'delta_mae_pts');
    const cov = readNumber(tail, 'mon_cov');
    const monScore = readNumber(tail, 'mon_score');
    if (delta === null || cov === null || monScore === null) continue;
    last = {
      epoch: Number(m[1]),
      loss: readNumber(tail, 'loss'),
      valLoss: readNumber(tail, 'val_loss'),
      phase: readTail(tail, 'phase'),
      delta,
      cov,
      monScore,
      progress: readTail(tail, 'progress'),
      epochSec: readNumber(tail, 'epoch_sec'),
      avgEpochSec: readNumber(tail, 'avg_epoch_sec'),
      elapsed: readTail(tail, 'elapsed'),
      eta: readTail(tail, 'eta'),
    };
  }
  return last;
};

const parseTestMetrics = (logText: string): Metrics | null => {
  const legacy =
    /TEST RESULTS:\s+delta_mae_pts\s*=\s*([0-9.]+),\s+recap_mae_pts\s*=\s*([0-9.]+),\s+cat_mae_pts\s*=\s*([0-9.]+),\s+total_mae_pts\s*=\s*([0-9.]+),\s+coverage\s*=\s*([0-9.]+),\s+width\s*=\s*([0-9.]+),\s+width_floor_pct\s*=\s*([0-9.]+)/;
  const current =
    /test_all:\s+delta_mae_pts=([0-9.]+),\s+recap_mae_pts=([0-9.]+),\s+total_mae_pts=([0-9.]+),\s+coverage=([0-9.]+),\s+width=([0-9.]+)/;
  const m = legacy.exec(logText);
  if (m) {
    return {
      deltaMaePts: Number(m[1]),
      recapMaePts: Number(m[2]),
      categoryMaePts: Number(m[3]),
      totalMaePts: Number(m[4]),
      coverage: Number(m[5]),
      width: Number(m[6]),
      widthFloorPct: Number(m[7]),
    };
  }
  const currentMatch = current.exec(logText);
  if (!currentMatch) return null;
  return {
    deltaMaePts: Number(currentMatch[1]),
    recapMaePts: Number(currentMatch[2]),
    categoryMaePts: Number.NaN,
    totalMaePts: Number(currentMatch[3]),
    coverage: Number(currentMatch[4]),
    width: Number(currentMatch[5]),
    widthFloorPct: Number.NaN,
  };
};

const hasInstability = (logText: string): boolean => {
  if (/\bloss\s*=\s*NaN\b/i.test(logText)) return true;
  if (/\bloss\s*=\s*Infinity\b/i.test(logText)) return true;
  if (/\bNaN\b/.test(logText)) return true;
  if (/\bInfinity\b/.test(logText)) return true;
  return false;
};

const buildBaseRunArgs = (cli: CliArgs, runId: string, extra: string[]) => [
  'tsx',
  cli.trainingScript,
  '--trial-id',
  runId,
  '--epochs',
  String(cli.epochs),
  '--samples-per-epoch',
  String(cli.samplesPerEpoch),
  '--batch',
  String(cli.batch),
  '--val-mode',
  cli.valMode,
  '--division-filter',
  cli.divisionFilter,
  ...(cli.curriculumPhaseAEnd !== undefined
    ? ['--curriculum-phase-a-end', String(cli.curriculumPhaseAEnd)]
    : []),
  ...(cli.curriculumPhaseBEnd !== undefined
    ? ['--curriculum-phase-b-end', String(cli.curriculumPhaseBEnd)]
    : []),
  ...(cli.curriculumPhaseCRamp !== undefined
    ? ['--curriculum-phase-c-ramp', String(cli.curriculumPhaseCRamp)]
    : []),
  ...(cli.autoCurriculum ? ['--auto-curriculum', cli.autoCurriculum] : []),
  ...(cli.autoCurriculumPatience !== undefined
    ? ['--auto-curriculum-patience', String(cli.autoCurriculumPatience)]
    : []),
  ...(cli.autoCurriculumMinCoverage !== undefined
    ? ['--auto-curriculum-min-coverage', String(cli.autoCurriculumMinCoverage)]
    : []),
  ...(cli.autoCurriculumMinDeltaGain !== undefined
    ? ['--auto-curriculum-min-delta-gain', String(cli.autoCurriculumMinDeltaGain)]
    : []),
  ...(cli.autoCurriculumPhaseAMin !== undefined
    ? ['--auto-curriculum-phase-a-min', String(cli.autoCurriculumPhaseAMin)]
    : []),
  ...(cli.autoCurriculumPhaseBMin !== undefined
    ? ['--auto-curriculum-phase-b-min', String(cli.autoCurriculumPhaseBMin)]
    : []),
  ...(cli.widthTargetPts !== undefined ? ['--width-target-pts', String(cli.widthTargetPts)] : []),
  ...(cli.widthPenaltyWeight !== undefined
    ? ['--width-penalty-weight', String(cli.widthPenaltyWeight)]
    : []),
  ...(cli.coverageTarget !== undefined ? ['--coverage-target', String(cli.coverageTarget)] : []),
  ...(cli.overCoverageWeight !== undefined
    ? ['--over-coverage-weight', String(cli.overCoverageWeight)]
    : []),
  ...(cli.coverageUpperTarget !== undefined
    ? ['--coverage-upper-target', String(cli.coverageUpperTarget)]
    : []),
  ...(cli.historyHideRate !== undefined
    ? ['--history-hide-rate', String(cli.historyHideRate)]
    : []),
  ...(cli.valDateCutoff ? ['--val-date-cutoff', cli.valDateCutoff] : []),
  ...(cli.maxRows !== undefined ? ['--maxRows', String(cli.maxRows)] : []),
  ...extra,
];

const addLearning = (learningsPath: string, heading: string, lines: string[]) => {
  const section = [`## ${heading}`, ...lines.map((line) => `- ${line}`), ''].join('\n');
  fs.appendFileSync(learningsPath, `${section}\n`);
};

const writeJson = (filePath: string, value: unknown) => {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const summarizeRun = (run: RunSummary): string[] => {
  const lines: string[] = [];
  if (run.completed) {
    lines.push('Run completed successfully.');
  } else if (run.aborted) {
    lines.push('Run aborted due to instability guardrail.');
  } else {
    lines.push('Run ended before completion.');
  }
  if (run.lastEpoch !== null) {
    lines.push(`Last epoch observed: ${run.lastEpoch}.`);
  }
  if (run.lastTrainLoss !== null || run.lastValLoss !== null) {
    lines.push(
      `Last losses: train=${run.lastTrainLoss?.toFixed(6) ?? 'n/a'}, val=${run.lastValLoss?.toFixed(6) ?? 'n/a'}.`
    );
  }
  if (run.lastDeltaMaePts !== null && run.lastCoverage !== null) {
    lines.push(
      `Last val snapshot: delta_mae_pts=${run.lastDeltaMaePts.toFixed(4)}, coverage=${run.lastCoverage.toFixed(3)}, mon_score=${(run.lastMonScore ?? NaN).toFixed(4)}.`
    );
  }
  if (run.testMetrics) {
    lines.push(
      `Test: delta=${run.testMetrics.deltaMaePts.toFixed(4)}, coverage=${run.testMetrics.coverage.toFixed(3)}, width=${run.testMetrics.width.toFixed(4)}.`
    );
  }
  if (run.unstable) {
    lines.push('Instability detected (NaN/Infinity in log).');
  }
  return lines;
};

const scoreMetrics = (m: Metrics | null): number => {
  if (!m) return Number.POSITIVE_INFINITY;
  const covDeviation = Math.abs(m.coverage - 0.84);
  const widthPenalty = Math.max(0, m.width - 2.5);
  return m.deltaMaePts + covDeviation * 1.5 + widthPenalty * 0.2;
};

const pickBestIntervalRun = (runs: RunSummary[]): RunSummary | null => {
  const intervalRuns = runs.filter((r) =>
    [
      'interval-control',
      'interval-w1p0',
      'interval-cov4',
      'interval-cov3',
      'interval-w1p0-cov4',
      'interval-w1p0-cov3',
    ].includes(r.stage)
  );
  if (intervalRuns.length === 0) return null;
  let best: RunSummary | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const run of intervalRuns) {
    const score = scoreMetrics(run.testMetrics);
    if (score < bestScore) {
      bestScore = score;
      best = run;
    }
  }
  return best;
};

const replaceToken = (input: string, token: string, value: string): string =>
  input.split(token).join(value);

const parseRunArgsToCarryForward = (run: RunSummary): string[] => {
  const carry = ['--base-width-multiplier', '--coverage-sharpness'];
  const selected: string[] = [];
  for (let i = 0; i < run.args.length; i++) {
    const token = run.args[i];
    if (token && carry.includes(token)) {
      const value = run.args[i + 1];
      if (value) {
        selected.push(token, value);
      }
    }
  }
  return selected;
};

const maybeRunOpencode = (
  cli: CliArgs,
  run: RunSummary,
  sessionDir: string,
  learningsPath: string
): Effect.Effect<void, never, never> => {
  if (!cli.opencodeCmd && !cli.opencodeAnalyze) return Effect.void;

  const summaryPath = path.join(sessionDir, 'runs.json');
  const notesPath = path.join(sessionDir, 'opencode-notes.md');
  const runShellCommand = (cmd: string) =>
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(cmd, {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
          });

          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            process.stdout.write(text);
          });
          child.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            process.stderr.write(text);
          });

          child.on('exit', (code) => {
            const section = [
              `## ${run.id}`,
              '',
              '```text',
              stdout.trim() || '(no stdout)',
              stderr.trim() ? `\n[stderr]\n${stderr.trim()}` : '',
              '```',
              '',
            ].join('\n');
            fs.appendFileSync(notesPath, `${section}\n`);
            addLearning(learningsPath, `${run.id} opencode`, [
              `OpenCode analysis recorded in ${notesPath}.`,
            ]);

            if ((code ?? 1) === 0) resolve();
            else reject(new Error(`opencode command failed: ${code}`));
          });
          child.on('error', reject);
        }),
      catch: (error) => {
        console.warn(`opencode analysis command failed: ${String(error)}`);
        return error;
      },
    }).pipe(Effect.catch(() => Effect.void));

  if (cli.opencodeCmd) {
    const cmd = [
      ['{run_id}', run.id],
      ['{log}', run.logPath],
      ['{summary}', summaryPath],
      ['{session_dir}', sessionDir],
    ].reduce((acc, [token, value]) => replaceToken(acc, token, value), cli.opencodeCmd);
    return runShellCommand(cmd);
  }

  const promptPath = path.isAbsolute(cli.opencodePromptFile)
    ? cli.opencodePromptFile
    : path.join(process.cwd(), cli.opencodePromptFile);
  const basePrompt = readFileSafe(promptPath);
  const prompt = [
    basePrompt || 'Analyze the attached run log and summarize stability, trends, and next action.',
    '',
    `Run ID: ${run.id}`,
    `Stage: ${run.stage}`,
    `Log path: ${run.logPath}`,
    `Summary path: ${summaryPath}`,
  ].join('\n');

  const opencodeArgs = [
    'run',
    '--file',
    run.logPath,
    '--file',
    summaryPath,
    ...(cli.opencodeModel ? ['--model', cli.opencodeModel] : []),
    ...(cli.opencodeAgent ? ['--agent', cli.opencodeAgent] : []),
    '--',
    prompt,
  ];

  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn('opencode', opencodeArgs, {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
          const text = chunk.toString();
          stdout += text;
          process.stdout.write(text);
        });
        child.stderr?.on('data', (chunk) => {
          const text = chunk.toString();
          stderr += text;
          process.stderr.write(text);
        });

        child.on('exit', (code) => {
          const section = [
            `## ${run.id}`,
            '',
            '```text',
            stdout.trim() || '(no stdout)',
            stderr.trim() ? `\n[stderr]\n${stderr.trim()}` : '',
            '```',
            '',
          ].join('\n');
          fs.appendFileSync(notesPath, `${section}\n`);
          addLearning(learningsPath, `${run.id} opencode`, [
            `OpenCode analysis recorded in ${notesPath}.`,
          ]);

          if ((code ?? 1) === 0) resolve();
          else reject(new Error(`opencode analysis failed: ${code}`));
        });
        child.on('error', reject);
      }),
    catch: (error) => {
      console.warn(`opencode analysis failed: ${String(error)}`);
      return error;
    },
  }).pipe(Effect.catch(() => Effect.void));
};

const runSingle = (
  cli: CliArgs,
  run: RunDef,
  sessionDir: string,
  runsPath: string,
  learningsPath: string,
  allRuns: RunSummary[]
): Effect.Effect<RunSummary, never, never> =>
  Effect.gen(function* () {
    const startedAt = new Date();
    const logPath = path.join(sessionDir, `${run.id}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    const args = buildBaseRunArgs(cli, run.id, run.args);
    const commandPreview = `npx ${args.join(' ')}`;

    yield* (Console.log(`\n=== Running ${run.id} (${run.stage}) ===`));
    yield* (Console.log(commandPreview));

    if (cli.dryRun) {
      const drySummary: RunSummary = {
        id: run.id,
        stage: run.stage,
        args: run.args,
        logPath,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMinutes: 0,
        completed: false,
        unstable: false,
        aborted: false,
        lastEpoch: null,
        lastTrainLoss: null,
        lastValLoss: null,
        lastDeltaMaePts: null,
        lastCoverage: null,
        lastMonScore: null,
        testMetrics: null,
        notes: ['Dry run only; command not executed.'],
      };
      allRuns.push(drySummary);
      writeJson(runsPath, allRuns);
      addLearning(learningsPath, `${run.id} (${run.stage})`, drySummary.notes);
      return drySummary;
    }

    const child = spawn('npx', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    let exited = false;
    let exitCode: number | null = null;
    let aborted = false;
    let unstable = false;
    let lastPrintedEpoch = -1;

    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      logStream.end();
    });

    while (!exited) {
      yield* (Effect.sleep(`${cli.pollSeconds} seconds`));
      const text = readFileSafe(logPath);
      const latest = parseLastEpochMetrics(text);
      if (latest && latest.epoch > lastPrintedEpoch) {
        lastPrintedEpoch = latest.epoch;
        const timing = [
          latest.progress ? `progress=${latest.progress}` : null,
          latest.epochSec !== null ? `epoch=${latest.epochSec.toFixed(1)}s` : null,
          latest.avgEpochSec !== null ? `avg=${latest.avgEpochSec.toFixed(1)}s` : null,
          latest.elapsed ? `elapsed=${latest.elapsed}` : null,
          latest.eta ? `eta=${latest.eta}` : null,
        ]
          .filter(Boolean)
          .join(' | ');
        yield* (
          Console.log(
            `[${run.id}] epoch ${latest.epoch}` +
              `${latest.phase ? ` | phase=${latest.phase}` : ''}` +
              `${latest.loss !== null ? ` | loss=${latest.loss.toFixed(6)}` : ''}` +
              `${latest.valLoss !== null ? ` | val_loss=${latest.valLoss.toFixed(6)}` : ''}` +
              ` | delta=${latest.delta.toFixed(4)} | cov=${latest.cov.toFixed(3)} | mon=${latest.monScore.toFixed(4)}` +
              `${timing ? ` | ${timing}` : ''}`
          )
        );
      }
      if (!unstable && hasInstability(text)) {
        unstable = true;
        aborted = true;
        yield* (Console.error(`[${run.id}] instability detected; terminating run.`));
        child.kill('SIGTERM');
      }
    }

    const endedAt = new Date();
    const finalText = readFileSafe(logPath);
    const last = parseLastEpochMetrics(finalText);
    const completed = /Production training complete\./.test(finalText);
    const testMetrics = parseTestMetrics(finalText);

    const summary: RunSummary = {
      id: run.id,
      stage: run.stage,
      args: run.args,
      logPath,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMinutes: (endedAt.getTime() - startedAt.getTime()) / 60000,
      completed,
      unstable,
      aborted,
      lastEpoch: last?.epoch ?? null,
      lastTrainLoss: last?.loss ?? null,
      lastValLoss: last?.valLoss ?? null,
      lastDeltaMaePts: last?.delta ?? null,
      lastCoverage: last?.cov ?? null,
      lastMonScore: last?.monScore ?? null,
      testMetrics,
      notes: [
        `Exit code: ${exitCode ?? 'unknown'}.`,
        ...(unstable ? ['Guardrail trigger: NaN/Infinity detected.'] : []),
        ...(completed ? ['Completion marker found in log.'] : ['Completion marker missing.']),
      ],
    };

    allRuns.push(summary);
    writeJson(runsPath, allRuns);

    addLearning(learningsPath, `${run.id} (${run.stage})`, summarizeRun(summary));
    yield* (maybeRunOpencode(cli, summary, sessionDir, learningsPath));

    return summary;
  });

const makeIntervalRuns = (prefix: string, skipControl: boolean): RunDef[] => {
  const runs: RunDef[] = [];
  if (!skipControl) {
    runs.push({ id: `${prefix}_ctrl`, stage: 'interval-control', args: [] });
  }
  runs.push({
    id: `${prefix}_w1p0`,
    stage: 'interval-w1p0',
    args: ['--base-width-multiplier', '1.0'],
  });
  runs.push({
    id: `${prefix}_cov4`,
    stage: 'interval-cov4',
    args: ['--coverage-sharpness', '4.0'],
  });
  runs.push({
    id: `${prefix}_w1p0_cov4`,
    stage: 'interval-w1p0-cov4',
    args: ['--base-width-multiplier', '1.0', '--coverage-sharpness', '4.0'],
  });
  return runs;
};

const program = Effect.gen(function* () {
  const cli = parseCli(process.argv.slice(2));

  const sessionDir = path.join(cli.outDir, `v9-subcaption-ablation-${nowStamp()}`);
  ensureDir(sessionDir);
  const runsPath = path.join(sessionDir, 'runs.json');
  const learningsPath = path.join(sessionDir, 'learnings.md');
  const manifestPath = path.join(sessionDir, 'manifest.json');

  const runSummaries: RunSummary[] = [];
  fs.writeFileSync(
    learningsPath,
    [
      '# V9 Subcaption Ablation Learnings',
      '',
      `Session: ${sessionDir}`,
      `Started: ${new Date().toISOString()}`,
      '',
    ].join('\n')
  );

  writeJson(manifestPath, {
    sessionDir,
    cli,
    startedAt: new Date().toISOString(),
  });

  yield* (Console.log(`Session dir: ${sessionDir}`));
  yield* (Console.log(`Learnings log: ${learningsPath}`));

  const intervalRuns = makeIntervalRuns(cli.prefix, cli.skipControl);
  let executedRuns = 0;
  for (const run of intervalRuns) {
    if (cli.limitRuns && executedRuns >= cli.limitRuns) break;
    const summary = yield* (
      runSingle(cli, run, sessionDir, runsPath, learningsPath, runSummaries)
    );
    executedRuns += 1;

    if (run.stage === 'interval-cov4' && summary.unstable) {
      const fallback: RunDef = {
        id: `${cli.prefix}_cov3`,
        stage: 'interval-cov3',
        args: ['--coverage-sharpness', '3.0'],
        fallbackFor: run.id,
      };
      yield* (Console.log(`Adding fallback run ${fallback.id} due to instability in ${run.id}.`));
      if (cli.limitRuns && executedRuns >= cli.limitRuns) break;
      yield* (runSingle(cli, fallback, sessionDir, runsPath, learningsPath, runSummaries));
      executedRuns += 1;
    }

    if (run.stage === 'interval-w1p0-cov4' && summary.unstable) {
      const fallback: RunDef = {
        id: `${cli.prefix}_w1p0_cov3`,
        stage: 'interval-w1p0-cov3',
        args: ['--base-width-multiplier', '1.0', '--coverage-sharpness', '3.0'],
        fallbackFor: run.id,
      };
      yield* (Console.log(`Adding fallback run ${fallback.id} due to instability in ${run.id}.`));
      if (cli.limitRuns && executedRuns >= cli.limitRuns) break;
      yield* (runSingle(cli, fallback, sessionDir, runsPath, learningsPath, runSummaries));
      executedRuns += 1;
    }
  }

  if (cli.limitRuns && executedRuns >= cli.limitRuns) {
    writeJson(runsPath, runSummaries);
    yield* (Console.log('Ablation orchestration complete (limit-runs reached).'));
    yield* (Console.log(`Run summaries: ${runsPath}`));
    yield* (Console.log(`Learned notes: ${learningsPath}`));
    return;
  }

  const bestInterval = pickBestIntervalRun(runSummaries);
  const carryArgs = bestInterval ? parseRunArgsToCarryForward(bestInterval) : [];
  if (!bestInterval) {
    if (cli.dryRun) {
      addLearning(learningsPath, 'Interval selection', [
        'Dry-run mode: no completed runs to rank.',
        'Using default carry-forward args: (default).',
      ]);
    } else {
      yield* (Console.error('No completed interval runs available to continue.'));
      return;
    }
  } else {
    addLearning(learningsPath, 'Interval selection', [
      `Selected best interval config from ${bestInterval.id}.`,
      `Carry-forward args: ${carryArgs.length ? carryArgs.join(' ') : '(default)'}.`,
    ]);
  }

  const downstream: RunDef[] = [
    {
      id: `${cli.prefix}_best_only`,
      stage: 'swa-vs-best',
      args: [...carryArgs, '--swa', 'false'],
    },
    {
      id: `${cli.prefix}_swa_train_best_export`,
      stage: 'swa-vs-best',
      args: [...carryArgs, '--swa', 'true', '--final-weights', 'best'],
    },
    {
      id: `${cli.prefix}_idfloor0`,
      stage: 'identity-floor',
      args: [...carryArgs, '--identity-dropout-floor', '0.0'],
    },
    {
      id: `${cli.prefix}_trunk256`,
      stage: 'accuracy-trunk',
      args: [...carryArgs, '--accuracy-trunk-units', '256'],
    },
    {
      id: `${cli.prefix}_mbmp14`,
      stage: 'mbmp-emphasis',
      args: [...carryArgs, '--mbmp-loss-boost', '1.4'],
    },
  ];

  for (const run of downstream) {
    if (cli.limitRuns && executedRuns >= cli.limitRuns) break;
    yield* (runSingle(cli, run, sessionDir, runsPath, learningsPath, runSummaries));
    executedRuns += 1;
  }

  writeJson(runsPath, runSummaries);

  const ranked = runSummaries
    .filter((run) => run.testMetrics)
    .map((run) => ({ id: run.id, score: scoreMetrics(run.testMetrics), metrics: run.testMetrics }))
    .sort((a, b) => a.score - b.score);

  addLearning(
    learningsPath,
    'Final ranking',
    ranked.slice(0, 5).map((item, idx) => {
      const metrics = item.metrics!;
      return `${idx + 1}. ${item.id} | score=${item.score.toFixed(4)} | delta=${metrics.deltaMaePts.toFixed(4)} cov=${metrics.coverage.toFixed(3)} width=${metrics.width.toFixed(4)}`;
    })
  );

  yield* (Console.log('Ablation orchestration complete.'));
  yield* (Console.log(`Run summaries: ${runsPath}`));
  yield* (Console.log(`Learned notes: ${learningsPath}`));
});

Effect.runPromise(program).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
