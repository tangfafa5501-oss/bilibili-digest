const test = require("node:test");
const assert = require("node:assert/strict");

const BVID = "BV1xx411c7mD";

// ---- 假 B 站 API（网络桩）：必须在 require 模块之前挂上全局，
// ---- 顶层的 typeof 守卫才会走注入分支。
const apiCalls = [];
globalThis.BILI_API = {
  parseBvid: (value) => (/BV[0-9A-Za-z]{10}/.test(String(value || "")) ? BVID : null),
  fetchVideoInfo: async () => {
    apiCalls.push("fetchVideoInfo");
    return { title: "测试视频", owner: { name: "UP 主" } };
  },
  fetchSubtitleTracks: async () => ({
    tracks: [
      { id: "human-1", url: "https://subtitle.example/json", lang: "zh-CN", langLabel: "中文", isAi: false },
      { id: "ai-2", url: "https://subtitle.example/ai", lang: "ai-zh", langLabel: "AI 中文", isAi: true },
    ],
    needLogin: false,
  }),
  pickSubtitleTrack: (tracks) => tracks[0],
  fetchSubtitleTrackContent: async (url) => {
    apiCalls.push(`content:${url}`);
    // 生产里 bili-api 同时保留原始字段与扩展内部时间视图。
    return url.includes("json")
      ? [
          { from: 0, to: 2, content: "第一句", start: 0, duration: 2, text: "第一句" },
          { from: 2, to: 4, content: "第二句", start: 2, duration: 2, text: "第二句" },
        ]
      : [];
  },
};

const SERVICE_MODULE = require("../lib/transcript-service.js");
const LEARNING_STORE = require("../lib/learning-store.js");
const IDB = require("../lib/idb.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");

function makeFakeCache(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const calls = { load: 0, save: 0 };
  return {
    rows,
    calls,
    async load(bvid, { page = 1 } = {}) {
      calls.load += 1;
      const key = `${bvid}:p${page}`;
      return rows.has(key) ? structuredClone(rows.get(key)) : null;
    },
    async save(bvid, data, { page = 1 } = {}) {
      calls.save += 1;
      rows.set(`${bvid}:p${page}`, structuredClone(data));
      return true;
    },
  };
}

function makeHarness({ cache = makeFakeCache(), learningRecords = {} } = {}) {
  const idb = createMemoryIndexedDb();
  const learningRepo = LEARNING_STORE.createLearningRepository({
    driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
  });
  const storageLike = {
    data: { ...learningRecords },
    async get(key) {
      if (key == null) return structuredClone(this.data);
      const out = {};
      for (const k of [].concat(key)) if (k in this.data) out[k] = structuredClone(this.data[k]);
      return out;
    },
    async set(entries) {
      Object.assign(this.data, structuredClone(entries));
    },
    async remove(key) {
      for (const k of [].concat(key)) delete this.data[k];
    },
  };

  // 迁移闸直接把散存的概览搬进仓储，等价于生产里迁移链的最终状态。
  const repo = LEARNING_STORE.createLearningRepository({
    driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
  });

  const service = SERVICE_MODULE.createTranscriptService({
    cache,
    dataReady: async () => {},
    learningRepository: () => repo,
    getSettings: async () => ({ subtitleLangPreference: "" }),
    logDebug: () => {},
    logError: () => {},
  });
  return { service, repo, storageLike };
}

const baseDeps = () => makeHarness();

// ============================================================
// 获取管线
// ============================================================

test("无效 BV 号直接拒绝", async () => {
  const { service } = baseDeps();
  const result = await service.fetchTranscript("不是BV号");
  assert.equal(result.success, false);
  assert.equal(result.error, "INVALID_BVID");
});

test("缓存命中时不再走网络，脏标志被现算值覆盖", async () => {
  apiCalls.length = 0;
  const cache = makeFakeCache({
    [`${BVID}:p1`]: {
      transcript: [{ start: 0, text: "缓存句" }],
      success: false,
      fromCache: false,
    },
  });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1 });

  assert.equal(result.success, true);
  assert.equal(result.fromCache, true);
  assert.equal(apiCalls.length, 0, "命中缓存不应访问网络");
});

test("旧缓存迁移为 canonical cue，并清掉自然句级派生译文", async () => {
  apiCalls.length = 0;
  const analysis = { chapters: [{ title: "保留的概览" }] };
  const analysisFailures = [{ index: 2, startSeconds: 120, endSeconds: 180 }];
  const cache = makeFakeCache({
    [`${BVID}:p1`]: {
      segmentSchemaVersion: 3,
      transcript: [
        { start: 0, duration: 2, text: "第一句。第二句！" },
        { start: 2, duration: 2, text: "没有标点的尾句" },
      ],
      segments: [{ id: "segment-s0-0-0", start: 0, text: "第一句。" }],
      polished: {
        "segment-s0-0-0": "保留的顺句。",
        "已失效的-id": "不能错贴",
      },
      translated: { "segment-0-0": "旧译文" },
      translatedParts: { "segment-0-0::part-0": "只译了前半" },
      analysis,
      analysisFailures,
      unrelatedLearningState: { preserved: true },
    },
  });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1 });

  assert.equal(apiCalls.length, 0, "迁移缓存不应重新访问 B 站");
  assert.equal(result.segmentSchemaVersion, 6);
  assert.deepEqual(result.segments.map((segment) => segment.text), [
    "第一句。第二句！",
    "没有标点的尾句",
  ]);
  assert.deepEqual(result.segments.map((segment) => segment.start), [0, 2]);
  assert.deepEqual(result.polished, {});
  assert.deepEqual(result.translated, {});
  assert.deepEqual(result.translatedParts, {});
  assert.deepEqual(result.translatedCues, {});
  assert.ok(result.segments.every((segment) => segment.sourceParts.length > 0));
  assert.deepEqual(result.analysis, analysis, "概览等无关学习资料必须保留");
  assert.deepEqual(result.analysisFailures, analysisFailures);
  assert.deepEqual(result.unrelatedLearningState, { preserved: true });
  assert.equal(cache.calls.save, 1, "迁移结果应回写，后续不重复迁移");
});

test("schema 6 的有效 cue 译文重新派生自然句且不重复迁移", async () => {
  apiCalls.length = 0;
  const current = {
    transcript: [{
      cueId: "cue-0-0-2000",
      from: 0,
      to: 2,
      content: "Current sentence.",
      start: 0,
      duration: 2,
      text: "Current sentence.",
    }],
    segments: [{
      id: "segment-s0-0-0",
      start: 0,
      text: "Current sentence.",
      sourceCueIds: ["cue-0-0-2000"],
    }],
    segmentSchemaVersion: 6,
    translated: { "segment-s0-0-0": "当前句。" },
    translatedCues: {
      "cue-0-0-2000": {
        cueId: "cue-0-0-2000",
        start: 0,
        duration: 2,
        source: "Current sentence.",
        text: "当前句。",
        status: "translated",
      },
    },
    translationFailed: [],
    selectedTrack: { id: "cached-track", lang: "en-US", name: "英语", isAi: false },
  };
  const cache = makeFakeCache({ [`${BVID}:p1`]: current });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1 });

  assert.deepEqual(result.translated, current.translated);
  assert.deepEqual(result.selectedTrack, current.selectedTrack, "缓存恢复必须保留已选轨元数据");
  assert.deepEqual(
    result.transcript.map(({ from, to, content }) => ({ from, to, content })),
    [{ from: 0, to: 2, content: "Current sentence." }],
    "缓存恢复必须保留同一份原始 cue",
  );
  assert.equal(cache.calls.save, 0, "当前 schema 不应重复迁移");
  assert.equal(apiCalls.length, 0);
});

test("缓存只有不完整自然句译文时不会命中，会按当前 cue 清空", async () => {
  const cache = makeFakeCache({
    [`${BVID}:p1`]: {
      segmentSchemaVersion: 6,
      transcript: [
        { cueId: "cue-0-0-2000", start: 0, duration: 2, text: "First cue," },
        { cueId: "cue-1-2000-2000", start: 2, duration: 2, text: "second cue." },
      ],
      segments: [{
        id: "sentence",
        start: 0,
        text: "First cue, second cue.",
        sourceCueIds: ["cue-0-0-2000", "cue-1-2000-2000"],
      }],
      translated: { sentence: "只覆盖第一条" },
      translatedCues: {
        "cue-0-0-2000": {
          cueId: "cue-0-0-2000",
          start: 0,
          duration: 2,
          source: "First cue,",
          text: "第一条，",
          status: "translated",
        },
      },
    },
  });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1 });

  assert.deepEqual(result.translated, {});
  assert.equal(result.translatedCues["cue-0-0-2000"].status, "translated");
  assert.equal(cache.calls.save, 1, "坏的自然句派生缓存必须被重写");
});

test("缓存里的概览过期后能从学习资料恢复", async () => {
  const analysis = { chapters: [{ title: "长期章节" }] };
  const harness = baseDeps();
  await harness.repo.commit({
    put: [{
      schemaVersion: 2,
      learningId: `${BVID}:p1`,
      bvid: BVID,
      page: 1,
      analysis,
      updatedAt: 1000,
    }],
  });
  const cache = makeFakeCache({
    [`${BVID}:p1`]: { transcript: [{ start: 0, text: "缓存句" }] },
  });

  const result = await harness.service.fetchTranscript(BVID, { page: 1 });

  assert.equal(result.analysisSource, "learning");
  assert.deepEqual(result.analysis, analysis);
  void cache;
});

test("无字幕轨区分需要登录与确实没有", async () => {
  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [],
    needLogin: true,
  });
  const needLogin = await baseDeps().service.fetchTranscript(BVID);
  assert.equal(needLogin.error, "NEED_LOGIN");

  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [],
    needLogin: false,
  });
  const noSubtitle = await baseDeps().service.fetchTranscript(BVID);
  assert.equal(noSubtitle.error, "NO_SUBTITLE");

  // 还原给后续用例。
  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [
      { id: "human-1", url: "https://subtitle.example/json", lang: "zh-CN", langLabel: "中文", isAi: false },
      { id: "ai-2", url: "https://subtitle.example/ai", lang: "ai-zh", langLabel: "AI 中文", isAi: true },
    ],
    needLogin: false,
  });
});

test("正常拉取组装全部字段并写入缓存", async () => {
  apiCalls.length = 0;
  const cache = makeFakeCache();
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 2 });

  assert.equal(result.success, true);
  assert.equal(result.fromCache, false);
  assert.equal(result.language, "zh-CN");
  assert.equal(result.isAiSubtitle, false);
  assert.deepEqual(result.selectedTrack, {
    id: "human-1",
    lang: "zh-CN",
    name: "中文",
    isAi: false,
  });
  assert.deepEqual(result.availableTracks.map((track) => track.id), ["human-1", "ai-2"]);
  assert.deepEqual(
    result.transcript.map(({ from, to, content }) => ({ from, to, content })),
    [
      { from: 0, to: 2, content: "第一句" },
      { from: 2, to: 4, content: "第二句" },
    ],
  );
  assert.equal(result.segments.length > 0, true);
  assert.equal(result.segmentSchemaVersion, 6);
  assert.ok(result.transcriptText.includes("第一句"));
  assert.equal(cache.calls.save, 1, "应落缓存");
  assert.equal(
    "success" in cache.rows.get(`${BVID}:p2`),
    false,
    "响应专用的标志不进缓存",
  );
});

test("forceRefresh 绕过缓存直接拉新", async () => {
  apiCalls.length = 0;
  const cache = makeFakeCache({
    [`${BVID}:p1`]: { transcript: [{ start: 0, text: "旧缓存" }] },
  });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1, forceRefresh: true });

  assert.equal(result.fromCache, false);
  assert.ok(apiCalls.includes("fetchVideoInfo"), "应重新访问网络");
});

test("网络层错误码原样透出", async () => {
  globalThis.BILI_API.fetchVideoInfo = async () => {
    const error = new Error("风控了");
    error.code = "RISK_CONTROL";
    throw error;
  };
  const { service } = baseDeps();
  const result = await service.fetchTranscript(BVID);
  assert.equal(result.success, false);
  assert.equal(result.error, "RISK_CONTROL");
});

// ============================================================
// 缓存读改写助手
// ============================================================

test("updateCache 并发串行合并，互不覆盖", async () => {
  const cache = makeFakeCache({
    [`${BVID}:p1`]: { transcript: [], segments: [] },
  });
  const { service } = makeHarness({ cache });

  await Promise.all([
    service.updateCache(BVID, 1, (current) => ({
      ...current,
      polished: [...(current.polished || []), "批A"],
    })),
    service.updateCache(BVID, 1, (current) => ({
      ...current,
      translated: [...(current.translated || []), "批B"],
    })),
  ]);

  const stored = cache.rows.get(`${BVID}:p1`);
  assert.equal(stored.polished?.length, 1);
  assert.equal(stored.translated?.length, 1);
});

test("persistable 剥离响应专用的标志字段", () => {
  const { service } = baseDeps();
  const cleaned = service.persistable({
    success: true,
    fromCache: true,
    videoInfo: { title: "标题" },
  });
  assert.deepEqual(cleaned, { videoInfo: { title: "标题" } });
});
