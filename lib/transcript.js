/**
 * 字幕后处理：把逐条字幕重组成带真实起点的自然完整句。
 *
 * 有可靠句末标点时按自然句展示；没有句末标点时保留 B 站原始字幕条目，
 * 宁可显示得碎一些，也不按字符比例虚构句子开始时间。
 */
var BILI_TRANSCRIPT = (() => {
  // 缓存里的 polished / translated 都以 segment.id 为键。分句语义变化时必须
  // 提升版本，让字幕服务明确丢弃无法安全映射的旧改写结果，不能把段落译文
  // 错贴到一句新字幕上。
  const SEGMENT_SCHEMA_VERSION = 2;

  // 拉丁文本沿用上游阈值；CJK 按字符数折算到相近的信息量。
  const LATIN_LIMITS = Object.freeze({
    minChars: 60,
    idealChars: 180,
    maxChars: 320,
    maxSeconds: 20,
  });

  const CJK_LIMITS = Object.freeze({
    minChars: 30,
    idealChars: 90,
    maxChars: 160,
    maxSeconds: 20,
  });

  const CJK_PATTERN = /[\u3400-\u9fff]/g;

  /** CJK 字符占比超过三成就按中文排版处理。 */
  function limitsForEntries(entries) {
    const sample = (Array.isArray(entries) ? entries : [])
      .slice(0, 200)
      .map((entry) => String(entry?.text || ""))
      .join("");
    if (!sample) return LATIN_LIMITS;
    const cjkCount = (sample.match(CJK_PATTERN) || []).length;
    return cjkCount / sample.length > 0.3 ? CJK_LIMITS : LATIN_LIMITS;
  }

  function normalizeCaptionText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      // 用后顾断言而非捕获组：捕获组会吃掉右侧汉字，导致连续多个
      // 「汉字 空格 汉字」只清理得掉第一处。
      .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
      .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
      .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
      .trim();
  }

  // 优先切在标点上，退而求其次词边界，最后才按字符数硬切。
  function splitOversizedThought(text, maxChars) {
    const parts = [];
    let rest = normalizeCaptionText(text);

    while (rest.length > maxChars) {
      const windowText = rest.slice(0, maxChars + 1);
      const lowerBound = Math.floor(maxChars * 0.55);
      let cut = -1;

      for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(windowText))) {
          if (match.index >= lowerBound) cut = match.index + match[0].length;
        }
        if (cut > 0) break;
      }

      if (cut <= 0) cut = maxChars;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }

    if (rest) parts.push(rest);
    return parts;
  }

  const SENTENCE_END_PATTERN = /[.!?。！？]["')\]”’）】」』]*$/;
  const SENTENCE_PART_PATTERN = /[^.!?。！？]+(?:[.!?。！？]+["')\]”’）】」』]*)?/g;

  function makeSegment({ text, start, id, sourceEntryIndexes, fallback }) {
    const normalized = normalizeCaptionText(text);
    return {
      id,
      start,
      text: normalized,
      texts: [normalized],
      sourceEntryIndexes,
      fallback: Boolean(fallback),
    };
  }

  /**
   * 把逐条字幕重组成自然完整句。
   *
   * - 只把句号、问号、感叹号（含中英文形式）当作可靠句界；
   * - 一句跨越多条原始字幕时，时间取贡献首字的原始条目 start；
   * - 同一原始条目里有多句时，这些句子共享该条目的真实 start，不按字符
   *   比例虚构时间；
   * - 文件末尾没有可靠句末标点的内容按原始条目回退，保证仍可精确定位。
   *
   * limits 参数保留以兼容旧调用方，但自然句模式不再按字符数切段。
   */
  function groupTranscriptEntries(entries, limits) {
    void limits;
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const grouped = [];
    let pending = null;

    const appendPending = ({ text, start, entryIndex, partIndex }) => {
      if (!pending) {
        pending = {
          start,
          firstEntryIndex: entryIndex,
          firstPartIndex: partIndex,
          parts: [],
          byEntry: new Map(),
        };
      }
      pending.parts.push(text);
      const entryParts = pending.byEntry.get(entryIndex) || { start, parts: [] };
      entryParts.parts.push(text);
      pending.byEntry.set(entryIndex, entryParts);
    };

    const flushSentence = () => {
      if (!pending) return;
      grouped.push(
        makeSegment({
          text: pending.parts.join(" "),
          start: pending.start,
          id: `segment-s${pending.firstEntryIndex}-${pending.firstPartIndex}-${Math.round(pending.start * 1000)}`,
          sourceEntryIndexes: [...pending.byEntry.keys()],
          fallback: false,
        }),
      );
      pending = null;
    };

    entries.forEach((entry, entryIndex) => {
      const text = normalizeCaptionText(entry?.text);
      if (!text) return;
      const start = Number.isFinite(Number(entry?.start)) ? Number(entry.start) : 0;
      const sentenceParts = text.match(SENTENCE_PART_PATTERN) || [text];

      sentenceParts.forEach((sentencePart, partIndex) => {
        const cleanPart = normalizeCaptionText(sentencePart);
        if (!cleanPart) return;
        appendPending({ text: cleanPart, start, entryIndex, partIndex });
        if (SENTENCE_END_PATTERN.test(cleanPart)) flushSentence();
      });
    });

    // 没有句末标点的尾部不冒充自然句：逐条回退到原始字幕时间粒度。
    if (pending) {
      for (const [entryIndex, entry] of pending.byEntry) {
        grouped.push(
          makeSegment({
            text: entry.parts.join(" "),
            start: entry.start,
            id: `segment-r${entryIndex}-${Math.round(entry.start * 1000)}`,
            sourceEntryIndexes: [entryIndex],
            fallback: true,
          }),
        );
      }
    }

    return grouped;
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  // 纯文本用于展示 / 导出；带 [M:SS] 前缀的版本喂给模型，让它能引用真实时间点。
  function buildTranscriptTexts(entries) {
    const lines = Array.isArray(entries) ? entries : [];
    const plain = lines
      .map((entry) => normalizeCaptionText(entry?.text))
      .filter(Boolean)
      .join(" ");
    const timestamped = lines
      .map((entry) => {
        const text = normalizeCaptionText(entry?.text);
        return text ? `[${formatTimestamp(entry?.start)}] ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
    return { plain: plain.trim(), timestamped: timestamped.trim() };
  }

  /**
   * 决定侧边栏给顺句还是翻译入口。AI 字幕语言码带 `ai-` 前缀，脱掉再看主语言；
   * 拿不到语言码时按中文处理——B 站以中文视频为主，这个方向猜错代价更小。
   */
  function isChineseSubtitle(language) {
    const code = String(language || "")
      .trim()
      .toLowerCase();
    if (!code) return true;
    return code.replace(/^ai[-_]/, "").startsWith("zh");
  }

  return {
    SEGMENT_SCHEMA_VERSION,
    LATIN_LIMITS,
    CJK_LIMITS,
    limitsForEntries,
    isChineseSubtitle,
    normalizeCaptionText,
    splitOversizedThought,
    groupTranscriptEntries,
    formatTimestamp,
    buildTranscriptTexts,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_TRANSCRIPT;
}
