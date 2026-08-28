const test = require("node:test");
const assert = require("node:assert/strict");

const T = require("../lib/transcript.js");

const AI_CAPTIONS = [
  "今天我们来讲一下这个算法",
  "它的核心思想其实很简单",
  "就是把问题拆成更小的子问题",
  "然后逐个击破再合并结果",
  "这样时间复杂度会明显下降",
  "接下来我们看一个具体例子",
  "假设有一个长度为八的数组",
  "我们先把它平均分成两半",
  "分别对左右两边排序",
  "最后再做一次归并操作",
].map((text, index) => ({ text, start: index * 3, duration: 3 }));

test("按 CJK 占比自动选择分段阈值", () => {
  assert.equal(T.limitsForEntries(AI_CAPTIONS), T.CJK_LIMITS);
  assert.equal(
    T.limitsForEntries([{ text: "this is an english caption line", start: 0 }]),
    T.LATIN_LIMITS,
  );
  assert.equal(T.limitsForEntries([]), T.LATIN_LIMITS);
});

test("归一化清掉多余空白与中文字符间的空格", () => {
  assert.equal(T.normalizeCaptionText("  你 好   世界  "), "你好世界");
  assert.equal(T.normalizeCaptionText("hello   world"), "hello world");
  assert.equal(T.normalizeCaptionText("你好 ，世界"), "你好，世界");
  assert.equal(T.normalizeCaptionText(null), "");
});

test("超长无标点内容按上限硬切，但优先切在标点或词边界", () => {
  assert.deepEqual(T.splitOversizedThought("abcdefghij", 20), ["abcdefghij"]);

  const withComma = T.splitOversizedThought("aaaaaaaaaaaa，bbbbbbbbbbbb", 16);
  assert.equal(withComma[0], "aaaaaaaaaaaa，");
  assert.equal(withComma[1], "bbbbbbbbbbbb");

  const noBoundary = T.splitOversizedThought("啊".repeat(50), 20);
  assert.ok(noBoundary.every((part) => part.length <= 20));
  assert.equal(noBoundary.join(""), "啊".repeat(50));
});

test("无可靠句末标点时逐条回退，保留每条原始字幕的真实时间", () => {
  const segments = T.groupTranscriptEntries(AI_CAPTIONS);

  assert.equal(segments.length, AI_CAPTIONS.length);
  assert.deepEqual(
    segments.map(({ text, start, fallback }) => ({ text, start, fallback })),
    AI_CAPTIONS.map(({ text, start }) => ({ text, start, fallback: true })),
  );
});

test("迟到句号不会把 0:00 到 0:47 冒充成一个自然句", () => {
  const entries = [0, 10, 20, 30, 40, 47].map((start, index) => ({
    start,
    duration: index === 5 ? 1 : 5,
    text: index === 5 ? "finally ends." : `opening part ${index}`,
  }));

  const segments = T.groupTranscriptEntries(entries);

  assert.ok(segments.length >= 4, "迟到的句号不能把 47 秒内容压成一条");
  assert.deepEqual(
    segments.slice(0, 3).map(({ start, fallback }) => ({ start, fallback })),
    [
      { start: 0, fallback: true },
      { start: 10, fallback: true },
      { start: 20, fallback: true },
    ],
  );
  assert.ok(
    segments.every((segment) =>
      entries.some((entry) => entry.start === segment.start),
    ),
  );
});

test("中段长时间无标点时回退，句界恢复后继续自然句组合", () => {
  const entries = [
    { start: 0, duration: 4, text: "A complete opening." },
    { start: 5, duration: 5, text: "middle one" },
    { start: 15, duration: 5, text: "middle two" },
    { start: 25, duration: 5, text: "middle three" },
    { start: 35, duration: 5, text: "middle finally ends." },
    { start: 41, duration: 4, text: "Natural grouping resumes." },
  ];

  const segments = T.groupTranscriptEntries(entries);

  assert.equal(segments[0].fallback, false);
  assert.ok(segments.some((segment) => segment.start === 5 && segment.fallback));
  assert.ok(segments.some((segment) => segment.start === 25 && segment.fallback));
  assert.equal(segments.at(-1).text, "Natural grouping resumes.");
  assert.equal(segments.at(-1).fallback, false);
});

test("可靠窗口恰好等于阈值仍可成句，超过才逐条回退", () => {
  const limits = { maxSeconds: 20, maxChars: 999, maxEntries: 99 };
  const exact = T.groupTranscriptEntries(
    [
      { start: 0, duration: 10, text: "exactly" },
      { start: 10, duration: 10, text: "twenty seconds." },
    ],
    limits,
  );
  assert.deepEqual(exact.map(({ start, fallback }) => ({ start, fallback })), [
    { start: 0, fallback: false },
  ]);

  const exceeded = T.groupTranscriptEntries(
    [
      { start: 0, duration: 10, text: "over" },
      { start: 10, duration: 10, text: "the" },
      { start: 20, duration: 1, text: "limit." },
    ],
    limits,
  );
  assert.deepEqual(
    exceeded.map(({ start, fallback }) => ({ start, fallback })),
    [
      { start: 0, fallback: true },
      { start: 10, fallback: true },
      { start: 20, fallback: true },
    ],
  );
});

test("字符数超限也按原始条目回退，不等待很晚的句号", () => {
  const segments = T.groupTranscriptEntries(
    [
      { start: 0, duration: 2, text: "a".repeat(8) },
      { start: 2, duration: 2, text: "b".repeat(8) },
      { start: 4, duration: 2, text: "c".repeat(8) + "." },
    ],
    { maxSeconds: 999, maxChars: 20, maxEntries: 99 },
  );

  assert.deepEqual(segments.map((segment) => segment.start), [0, 2, 4]);
  assert.ok(segments.every((segment) => segment.fallback));
});

test("极密集字幕超过原始条目数上限也会回退", () => {
  const entries = Array.from({ length: 13 }, (_, index) => ({
    start: index * 0.5,
    duration: 0.25,
    text: index === 12 ? "end." : "part",
  }));
  const segments = T.groupTranscriptEntries(entries, {
    maxSeconds: 999,
    maxChars: 999,
    maxEntries: 12,
  });

  assert.equal(segments.length, 13);
  assert.ok(segments.every((segment) => segment.fallback));
});

test("自然句跨越多条字幕时取第一条的真实开始时间", () => {
  const entries = [
    { text: "第一句话讲的是背景，", start: 2, duration: 3 },
    { text: "它决定后续取舍。", start: 5, duration: 3 },
    { text: "第二句独立结束！", start: 8, duration: 3 },
  ];
  const segments = T.groupTranscriptEntries(entries);

  assert.deepEqual(
    segments.map(({ text, start, fallback }) => ({ text, start, fallback })),
    [
      { text: "第一句话讲的是背景，它决定后续取舍。", start: 2, fallback: false },
      { text: "第二句独立结束！", start: 8, fallback: false },
    ],
  );
});

test("同一原始字幕里的多句共享真实时间，不按字符比例伪造", () => {
  const segments = T.groupTranscriptEntries([
    { text: "第一句。第二句？第三句没有句号", start: 12.5, duration: 6 },
  ]);

  assert.deepEqual(
    segments.map(({ text, start, fallback }) => ({ text, start, fallback })),
    [
      { text: "第一句。", start: 12.5, fallback: false },
      { text: "第二句？", start: 12.5, fallback: false },
      { text: "第三句没有句号", start: 12.5, fallback: true },
    ],
  );
});

test("句末引号归入自然句，逗号和分号不提前切句", () => {
  const segments = T.groupTranscriptEntries([
    { text: "他说：“先看这里，", start: 0, duration: 2 },
    { text: "再看那里；最后结束。” 下一句！", start: 2, duration: 4 },
  ]);

  assert.deepEqual(segments.map((segment) => segment.text), [
    "他说：“先看这里，再看那里；最后结束。”",
    "下一句！",
  ]);
  assert.deepEqual(segments.map((segment) => segment.start), [0, 2]);
});

test("每句 id 在相同输入下保持稳定，供翻译和顺句缓存使用", () => {
  const first = T.groupTranscriptEntries(AI_CAPTIONS);
  const second = T.groupTranscriptEntries(AI_CAPTIONS);
  assert.deepEqual(first.map((s) => s.id), second.map((s) => s.id));
  assert.equal(first[0].start, 0);
  assert.match(first[0].id, /^segment-r0-0$/);
});

test("有标点的中文字幕在句末切分", () => {
  const entries = [
    { text: "第一句话讲的是背景，", start: 0, duration: 3 },
    { text: "它决定了后面所有的设计取舍。", start: 3, duration: 3 },
    { text: "第二句话开始讲实现细节，", start: 6, duration: 3 },
    { text: "这里有三个关键点需要注意。", start: 9, duration: 3 },
    { text: "第三句话聊的是性能开销，", start: 12, duration: 3 },
    { text: "主要瓶颈出现在内存分配上。", start: 15, duration: 3 },
    { text: "最后一句话做个总结收尾，", start: 18, duration: 3 },
    { text: "希望这个例子对你有帮助。", start: 21, duration: 3 },
  ];
  const segments = T.groupTranscriptEntries(entries);
  assert.equal(segments.length, 4);
  for (const segment of segments) {
    assert.match(segment.text, /[。！？]$/, "应该切在句号后");
  }
});

test("英文字幕沿用上游的拉丁阈值与断句行为", () => {
  const entries = [
    { text: "The first idea here is deceptively simple.", start: 0, duration: 4 },
    { text: "You split the problem into halves.", start: 4, duration: 4 },
    { text: "Then you solve each half on its own.", start: 8, duration: 4 },
    { text: "Finally you merge the two sorted halves.", start: 12, duration: 4 },
    { text: "That is the whole trick behind merge sort.", start: 16, duration: 4 },
  ];
  const segments = T.groupTranscriptEntries(entries);
  assert.ok(segments.length >= 1);
  for (const segment of segments) {
    assert.ok(segment.text.length <= T.LATIN_LIMITS.maxChars * 1.2);
    assert.doesNotMatch(segment.text, /\s{2,}/);
  }
});

test("空输入返回空数组", () => {
  assert.deepEqual(T.groupTranscriptEntries([]), []);
  assert.deepEqual(T.groupTranscriptEntries(null), []);
  assert.deepEqual(T.groupTranscriptEntries([{ text: "   ", start: 0 }]), []);
});

test("时间戳格式化为 M:SS", () => {
  assert.equal(T.formatTimestamp(0), "0:00");
  assert.equal(T.formatTimestamp(95), "1:35");
  assert.equal(T.formatTimestamp(3671), "61:11");
  assert.equal(T.formatTimestamp(-5), "0:00");
});

test("同时产出纯文本与带时间戳的文本视图", () => {
  const { plain, timestamped } = T.buildTranscriptTexts([
    { text: "开场白", start: 0, duration: 2 },
    { text: "正文内容", start: 95, duration: 3 },
    { text: "   ", start: 100, duration: 1 },
  ]);

  assert.equal(plain, "开场白 正文内容");
  assert.equal(timestamped, "[0:00] 开场白\n[1:35] 正文内容");
});

// ============================================================
// 字幕语种：决定给顺句还是给翻译
// ============================================================

test("认得出 B 站各种写法的中文字幕轨", () => {
  for (const code of ["zh-CN", "zh-Hans", "ai-zh", "AI-ZH", "zh"]) {
    assert.equal(T.isChineseSubtitle(code), true, `${code} 应判为中文`);
  }
});

test("外文字幕轨不判为中文", () => {
  for (const code of ["en-US", "ai-en", "ja", "ko"]) {
    assert.equal(T.isChineseSubtitle(code), false, `${code} 不应判为中文`);
  }
});

test("拿不到语言码时按中文处理", () => {
  // B 站以中文视频为主，猜中文猜错了只是少一个翻译入口，
  // 猜外文猜错了则会给一屏中文字幕摆上「翻译成中文」。
  assert.equal(T.isChineseSubtitle(""), true);
  assert.equal(T.isChineseSubtitle(null), true);
  assert.equal(T.isChineseSubtitle(undefined), true);
});
