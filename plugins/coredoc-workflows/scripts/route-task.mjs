#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { canonicalTaskId } from "../runtime/artifacts/contract.mjs";
import { workflowWorkItemsV3 } from "../runtime/capture/contract.mjs";
import {
  deliverCaptureEvent,
  preflightCaptureSchemaVersion,
  resolveWorkflowRuntime,
} from "./capture-client.mjs";
import { mintRunId, workflowEvent } from "./workflow-events.mjs";
import { startWorkflowRun } from "./workflow-run-state.mjs";

const INTENTS = new Set([
  "direct",
  "diagnose",
  "design",
  "change",
  "review",
  "spec",
  "qa",
  "qa-report",
  "benchmark",
  "security",
  "browse",
  "learn",
  "retro",
]);
const RISKS = new Set(["low", "normal", "high"]);
const SCALES = new Set(["normal", "large"]);

const CAPABILITIES = {
  investigate: {
    provider: "coredoc-workflows",
    skill: "coredoc-investigate",
  },
  design: {
    provider: "coredoc-workflows",
    skill: "coredoc-plan-review",
  },
  implement: {
    provider: "coredoc-workflows",
    skill: "coredoc-implement",
  },
  review: {
    provider: "coredoc-workflows",
    skill: "coredoc-review",
  },
  spec: {
    provider: "coredoc-workflows",
    skill: "coredoc-spec",
  },
  qa: {
    provider: "coredoc-workflows",
    skill: "coredoc-runtime-qa",
  },
  "qa-report": {
    provider: "coredoc-workflows",
    skill: "coredoc-runtime-qa-report",
  },
  benchmark: {
    provider: "coredoc-workflows",
    skill: "coredoc-benchmark",
  },
  security: {
    provider: "coredoc-workflows",
    skill: "coredoc-security-review",
  },
  browse: {
    provider: "coredoc-workflows",
    skill: "coredoc-browse",
  },
  learn: {
    provider: "coredoc-workflows",
    skill: "coredoc-learn",
  },
  retro: {
    provider: "coredoc-workflows",
    skill: "coredoc-retro",
  },
};

function stage(id, after = []) {
  return {
    id,
    ...CAPABILITIES[id],
    after,
  };
}

function assertRouteInput(input) {
  if (!INTENTS.has(input.intent)) {
    throw new Error(
      `Unsupported intent "${input.intent}". Expected one of: ${[...INTENTS].join(", ")}`,
    );
  }
  if (!RISKS.has(input.risk)) {
    throw new Error(
      `Unsupported risk "${input.risk}". Expected one of: ${[...RISKS].join(", ")}`,
    );
  }
  if (!SCALES.has(input.scale)) {
    throw new Error(
      `Unsupported scale "${input.scale}". Expected one of: ${[...SCALES].join(", ")}`,
    );
  }
}

function contextProvidersFor({
  intent,
  dataSensitive,
  runtimeSensitive,
}) {
  const contextProviders = [
    { id: "repo-rules", access: "read-only", required: true },
    { id: "git", access: "read-only", required: true },
    { id: "coredoc-graph", access: "read-only", required: false },
  ];

  if (dataSensitive) {
    contextProviders.push({
      id: "database-read-only",
      access: "read-only",
      required: false,
    });
  }
  if (
    runtimeSensitive ||
    ["qa", "qa-report", "benchmark", "browse"].includes(intent)
  ) {
    contextProviders.push({
      id: "runtime-observability",
      access: "read-only",
      required: false,
    });
  }
  if (["qa", "qa-report", "benchmark", "browse"].includes(intent)) {
    contextProviders.push({
      id: "ui-control",
      access: "task-scoped",
      required: true,
    });
  }
  return contextProviders;
}

export function routeTask({
  intent,
  risk = "normal",
  scale = "normal",
  bugLike = false,
  dataSensitive = false,
  runtimeSensitive = false,
}) {
  const input = {
    intent,
    risk,
    scale,
    bugLike,
    dataSensitive,
    runtimeSensitive,
  };
  assertRouteInput(input);
  const effectiveScale = ["change", "review"].includes(intent) ? scale : "normal";

  if (intent === "direct") {
    return {
      workflowId: "direct",
      intent,
      risk,
      scale: effectiveScale,
      stages: [],
      contextProviders: [],
    };
  }

  const stages = [];
  if (intent === "diagnose") {
    stages.push(stage("investigate"));
  } else if (intent === "change") {
    if (bugLike) {
      stages.push(stage("investigate"));
    }
    if (effectiveScale === "large") {
      stages.push(stage("spec", bugLike ? ["investigate"] : []));
      stages.push(stage("design", ["spec"]));
      stages.push({
        ...stage("implement", ["design"]),
        gate: "user-approval",
      });
    } else {
      stages.push(stage("implement", bugLike ? ["investigate"] : []));
    }
    if (effectiveScale === "large" || risk === "high") {
      stages.push(stage("review", ["implement"]));
    }
  } else {
    stages.push(stage(intent));
  }

  return {
    workflowId: [
      intent,
      bugLike && ["change", "diagnose"].includes(intent) ? "root-cause" : null,
      effectiveScale === "large" ? "large" : null,
      risk,
    ]
      .filter(Boolean)
      .join(":"),
    intent,
    risk,
    scale: effectiveScale,
    stages,
    contextProviders: contextProvidersFor(input),
  };
}

export function prepareRoutedTask(
  signals,
  { at = new Date(), entropy } = {},
) {
  const taskId =
    signals.taskId === undefined ? undefined : canonicalTaskId(signals.taskId);
  const workItems =
    signals.workItems === undefined
      ? undefined
      : workflowWorkItemsV3(signals.workItems);
  if (taskId !== undefined && workItems !== undefined) {
    throw new Error("--task-id and --work-item-* are mutually exclusive");
  }
  const route = routeTask(signals);
  const runId = mintRunId({
    at,
    ...(entropy === undefined ? {} : { entropy }),
  });
  const event = workflowEvent({
    at: at.toISOString(),
    runId,
    workflowId: route.workflowId,
    type: "route.selected",
    intent: route.intent,
    risk: route.risk,
  });
  return {
    route: {
      runId,
      ...route,
      ...(taskId === undefined ? {} : { taskId }),
      ...(workItems === undefined ? {} : { workItems }),
    },
    event,
  };
}

export async function recordRoutedTaskCapture(
  routed,
  {
    env = process.env,
    cwd = process.cwd(),
    createRecorder,
  } = {},
) {
  const delivered = await deliverCaptureEvent(
    {
      schemaVersion: routed.route.workItems === undefined ? 2 : 3,
      occurredAt: routed.event.at,
      type: "workflow.run.started",
      runId: routed.route.runId,
      ...(routed.route.taskId === undefined
        ? {}
        : { taskId: routed.route.taskId }),
      data: {
        workflowId: routed.route.workflowId,
        intent: routed.route.intent,
        risk: routed.route.risk,
        scale: routed.route.scale,
        stages: declaredStagesForRoute(routed.route),
        ...(routed.route.workItems === undefined
          ? {}
          : { workItems: routed.route.workItems }),
      },
    },
    {
      env,
      cwd,
      sessionId: env.COREDOC_WORKFLOWS_SESSION_ID,
      ...(createRecorder === undefined ? {} : { createRecorder }),
    },
  );
  const { durable: _durable, bindingRefused, unreadable, ...result } = delivered;
  if (result.status === "disabled") return { status: "disabled" };
  return {
    ...result,
    ...(bindingRefused ? { bindingRefused } : {}),
    ...(unreadable ? { unreadable } : {}),
  };
}

function declaredStagesForRoute(route) {
  return route.stages.map(({ id, after }) => ({
    stageId: id,
    after: [...after],
  }));
}

export function inferTaskSignals(task) {
  if (typeof task !== "string" || task.trim() === "") {
    throw new Error("Task text must be a non-empty string");
  }

  const text = task.toLowerCase();
  const has = (pattern) => pattern.test(text);
  const bugLike = has(
    /\b(bug|broken|error|regression|fails?|failure|fix)\b|баг|помил|зламан|не працю|виправ|полагод/,
  );
  const statusLike = has(
    /\b(give me an update|status update|progress update)\b|дай (?:статус|апдейт)|що вже зроблено/,
  );
  const asksForChange =
    !statusLike &&
    has(
      /\b(implement|build|add|change|create|refactor|port|fix|rewrite|overhaul|remove|delete|drop|rename|update|replace|migrate|deprecate|disable|enable)\b|\bdocument\s+(?:the|this|our|current|existing|how)\b|зроб|створ|дод|змін|рефактор|перенос|виправ|перепиш|видал|приб(?:ер|ира)|онов|переймен|замін|мігру|задокумент|вимкн|увімкн/,
    );

  let intent = "direct";
  if (
    has(
      /\b(security audit|security review|threat model|owasp|vulnerability|supply.chain)\b|аудит безпек|рев['’]?ю безпек|модел[ью] загроз|вразлив/,
    )
  ) {
    intent = "security";
  } else if (
    has(
      /\b(retro|retrospective|weekly review|what (?:did|have) we ship(?:ped)?|delivery review)\b|ретро|ретроспектив|що ми (?:зробили|зашипили)|підсумк.*тижн/,
    )
  ) {
    intent = "retro";
  } else if (
    has(
      /\b(remember this lesson|capture (?:this )?learning|what (?:did|have) we learn(?:ed)?|save (?:this )?(?:lesson|learning))\b|запам['’]?ятай.*урок|збереж.*(?:висновок|урок)|що ми (?:вивчили|дізналися)/,
    )
  ) {
    intent = "learn";
  } else if (
    has(
      /\b(benchmark|web vitals|page speed|performance baseline|performance regression)\b|бенчмарк|веб.?вітал|базов.*продуктив|регрес.*продуктив/,
    )
  ) {
    intent = "benchmark";
  } else if (
    has(
      /\b(qa.only|report.only qa|bug report only|test but don.t fix)\b|qa.?звіт|тільки звіт|не виправляй|без виправл/,
    )
  ) {
    intent = "qa-report";
  } else if (
    has(/\b(qa|browser test|desktop test|test this (?:site|app)|dogfood)\b|протестуй (?:сайт|десктоп|застосунок)|браузерн.*тест|перевір (?:сайт|десктоп|застосунок)/)
  ) {
    intent = "qa";
  } else if (
    has(
      /\b(write|create|draft|author).{0,20}\b(spec|specification|ticket|issue)\b|\b(spec|specification) for\b|напиш.*спек|створ.*спек|підгот.*тікет|опиш.*задач/,
    )
  ) {
    intent = "spec";
  } else if (
    has(/\b(open|browse|navigate|screenshot).{0,20}\b(page|site|url|browser)\b|відкрий.*брауз|зроб.*скрін|перейди.*сайт/)
  ) {
    intent = "browse";
  } else if (
    has(
      /\b(code review|review (this|the|my)? ?(pr|diff|code)|pre-landing)\b|рев['’]?ю|перевір.*\b(pr|diff|код)/,
    )
  ) {
    intent = "review";
  } else if (bugLike && !asksForChange) {
    intent = "diagnose";
  } else if (
    has(
      /\b(architecture|architect|design|implementation plan)\b|архітект|спроєкт|спроект|план реалізації/,
    )
  ) {
    intent = "design";
  } else if (asksForChange) {
    intent = "change";
  } else if (
    bugLike ||
    has(/\b(debug|diagnose|investigate|root cause)\b|діагност|дослід|чому/)
  ) {
    intent = "diagnose";
  }

  const dataSensitive = has(
    /\b(database|db|sql|query|migration|schema|entity|record)\b|баз[аи] дан|міграц|схем[аи]|запит/,
  );
  const runtimeSensitive = has(
    /\b(runtime|production|latency|slow|timeout|performance|trace|log|metric)\b|продакш|повіль|таймаут|продуктив|лог|метрик/,
  );
  const highRisk =
    intent === "security" ||
    has(
      /\b(auth|security|payment|migration|production|release|deploy|shared contract|public api)\b|авторизац|безпек|платіж|міграц|продакш|реліз|депло/,
    );
  const largeScope = has(
    /\b(parser|substrate|service|package|module|app|cli|pipeline|integration|component|subsystem|system|codebase|repository|repo|project)\b|парсер|сервіс|пакет|модуль|застосунок|компонент|підсистем|систем|кодову базу|репозитор|проєкт|проект/,
  );
  const explicitLargeConstruction = has(
    /\bnew\s+(?:package|service|parser|module|app|cli|pipeline|integration|component|subsystem|system)\b|\b(?:create|build|implement|port)\b.{0,40}\b(?:parser|substrate|service|package|module|integration|component|subsystem|system)\b|нов(?:ий|а|е)?\s+(?:пакет|сервіс|парсер|модуль|застосунок|компонент|підсистем|систем)|(?:створ|побуд|зроб).{0,40}(?:парсер|сервіс|пакет|модуль|компонент|підсистем|систем)/,
  );
  const largeScopeModifier = has(
    /\b(from scratch|greenfield|rewrite|overhaul|whole|entire|across\s+(?:all|the))\b|з нуля|весь|увесь|цілий|по всіх|перепиш/,
  );
  const largeScale =
    asksForChange &&
    (explicitLargeConstruction || (largeScope && largeScopeModifier));

  return {
    intent,
    risk: highRisk ? "high" : "normal",
    scale: largeScale ? "large" : "normal",
    bugLike,
    dataSensitive,
    runtimeSensitive,
  };
}

function parseArgs(args) {
  const options = {
    risk: "normal",
    scale: "normal",
    bugLike: false,
    dataSensitive: false,
    runtimeSensitive: false,
  };
  // Only the flags the caller actually passed. With `--task`, inference fills
  // the signals the caller left out; an explicit flag always wins over it.
  const explicit = {};
  let task;
  let taskId;
  const workItems = [];
  let currentWorkItem;

  const finishWorkItem = () => {
    if (currentWorkItem === undefined) return;
    if (currentWorkItem.externalId === undefined) {
      throw new Error("each --work-item-provider requires --work-item-external-id");
    }
    workItems.push(currentWorkItem);
    currentWorkItem = undefined;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--task") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--task requires a value");
      }
      task = value;
      index += 1;
    } else if (arg === "--task-id") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--task-id requires a value");
      }
      taskId = value;
      index += 1;
    } else if (arg === "--work-item-provider") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--work-item-provider requires a value");
      }
      finishWorkItem();
      currentWorkItem = { provider: value };
      index += 1;
    } else if (arg === "--work-item-external-id") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--work-item-external-id requires a value");
      }
      if (currentWorkItem === undefined) {
        throw new Error("--work-item-external-id requires a preceding --work-item-provider");
      }
      if (currentWorkItem.externalId !== undefined) {
        throw new Error("a work-item group may contain only one external id");
      }
      currentWorkItem.externalId = value;
      index += 1;
    } else if (arg === "--work-item-external-key") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--work-item-external-key requires a value");
      }
      if (currentWorkItem === undefined) {
        throw new Error("--work-item-external-key requires a preceding --work-item-provider");
      }
      if (currentWorkItem.externalKey !== undefined) {
        throw new Error("a work-item group may contain only one external key");
      }
      currentWorkItem.externalKey = value;
      index += 1;
    } else if (arg === "--intent" || arg === "--risk" || arg === "--scale") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2)] = value;
      explicit[arg.slice(2)] = value;
      index += 1;
    } else if (arg === "--bug-like") {
      options.bugLike = true;
      explicit.bugLike = true;
    } else if (arg === "--data-sensitive") {
      options.dataSensitive = true;
      explicit.dataSensitive = true;
    } else if (arg === "--runtime-sensitive") {
      options.runtimeSensitive = true;
      explicit.runtimeSensitive = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  finishWorkItem();

  const relationSignals =
    workItems.length === 0 ? {} : { workItems: workflowWorkItemsV3(workItems) };

  if (task !== undefined) {
    return {
      ...inferTaskSignals(task),
      ...explicit,
      ...(taskId === undefined ? {} : { taskId }),
      ...relationSignals,
    };
  }
  if (!options.intent) {
    throw new Error("--intent is required when --task is not provided");
  }
  return {
    ...options,
    ...(taskId === undefined ? {} : { taskId }),
    ...relationSignals,
  };
}

export async function executeRoutedTask(
  signals,
  {
    env = process.env,
    cwd = process.cwd(),
    preflight = preflightCaptureSchemaVersion,
    startRun = startWorkflowRun,
    recordCapture = recordRoutedTaskCapture,
  } = {},
) {
  const routed = prepareRoutedTask(signals);
  await preflight(routed.route.workItems === undefined ? 2 : 3, { env });
  const runState = startRun(
    {
      sessionId: env.COREDOC_WORKFLOWS_SESSION_ID,
      runId: routed.route.runId,
      workflowId: routed.route.workflowId,
      intent: routed.route.intent,
      risk: routed.route.risk,
      requiredSkills: routed.route.stages.map(({ skill }) => skill),
      declaredStages: declaredStagesForRoute(routed.route),
      at: routed.event.at,
      cwd,
    },
    { env },
  );
  const capture = await recordCapture(routed, { env, cwd });
  return {
    ...routed.route,
    runStateStatus: runState.status,
    capture,
  };
}

async function main() {
  try {
    const signals = parseArgs(process.argv.slice(2));
    const runtime = resolveWorkflowRuntime();
    const result = await executeRoutedTask(signals, { env: runtime.env });
    process.stdout.write(
      `${JSON.stringify(
        result,
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
